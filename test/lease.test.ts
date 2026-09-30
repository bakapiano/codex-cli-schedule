import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { startServer } from '../src/daemon.js';
import type { Dispatcher } from '../src/codex.js';

const storeModule = new URL('../src/store.js', import.meta.url).href;

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-schedule-lease-'));
  const path = join(dir, 'schedules.sqlite');
  const stores = new Set<Store>();
  const children: ChildProcess[] = [];
  const open = () => { const store = new Store(path); stores.add(store); return store; };
  const close = (store: Store) => { store.close(); stores.delete(store); };
  const store = open();
  t.after(async () => {
    for (const child of children) await terminate(child);
    for (const entry of stores) entry.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const metadata = (callback: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(path);
    try { callback(db); } finally { db.close(); }
  };
  return { dir, path, store, open, close, metadata, children };
}

test('stale modern lease is reclaimed even when its PID belongs to a live unrelated process', t => {
  const f = fixture(t);
  f.metadata(db => db.prepare('INSERT INTO daemon_lease VALUES(1,?,?)').run(process.pid, 'sqlite-lock:crashed-owner'));
  f.store.acquireLease('replacement');
  f.metadata(db => {
    const row = db.prepare('SELECT owner FROM daemon_lease WHERE singleton=1').get();
    assert.equal(row?.owner, 'sqlite-lock:replacement');
  });
  f.store.releaseLease('replacement');
});

test('kernel lock protects a live owner even if the diagnostic PID changes', t => {
  const f = fixture(t);
  const other = f.open();
  f.store.acquireLease('first');
  f.metadata(db => db.prepare('UPDATE daemon_lease SET pid=?').run(2_147_483_647));
  assert.throws(() => other.acquireLease('second'), /already owns/);
  other.releaseLease('first');
  assert.throws(() => other.acquireLease('second'), /already owns/);
  f.store.releaseLease('first');
  other.acquireLease('second');
  other.releaseLease('second');
});

test('closing the owning store releases the lock for another connection', t => {
  const f = fixture(t);
  const other = f.open();
  f.store.acquireLease('first');
  assert.throws(() => f.store.acquireLease('again'), /already owns/);
  f.close(f.store);
  other.acquireLease('second');
  other.releaseLease('second');
});

test('legacy live-PID leases are protected until a verified recovery removes them', t => {
  const f = fixture(t);
  f.metadata(db => db.prepare('INSERT INTO daemon_lease VALUES(1,?,?)').run(process.pid, 'legacy-owner'));
  assert.throws(() => f.store.acquireLease('new-owner'), /legacy lease PID/);
  f.metadata(db => {
    assert.equal(db.prepare('SELECT owner FROM daemon_lease').get()?.owner, 'legacy-owner');
    db.prepare('DELETE FROM daemon_lease WHERE owner=?').run('legacy-owner');
  });
  f.store.acquireLease('new-owner');
  f.store.releaseLease('new-owner');
});

test('legacy leases for a dead process are migrated to the kernel-backed format', t => {
  const f = fixture(t);
  f.metadata(db => db.prepare('INSERT INTO daemon_lease VALUES(1,?,?)').run(2_147_483_647, 'legacy-owner'));
  f.store.acquireLease('migrated');
  f.metadata(db => assert.equal(db.prepare('SELECT owner FROM daemon_lease').get()?.owner, 'sqlite-lock:migrated'));
  f.store.releaseLease('migrated');
});

test('closing a failed contender preserves the active lock against another process', t => {
  const f = fixture(t);
  const other = f.open();
  f.store.acquireLease('first');
  assert.throws(() => other.acquireLease('second'), /already owns/);
  f.close(other);
  const attempt = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(storeModule)};
    const store = new Store(process.argv[1]);
    try { store.acquireLease('contender'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { store.close(); }
  `, f.path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(attempt.status, 1, attempt.stderr);
  assert.match(attempt.stderr, /already owns/);
});

test('forced owner termination releases the OS lock and simulated PID reuse is recoverable', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(storeModule)};
    const store = new Store(process.argv[1]);
    store.acquireLease('child-owner');
    process.send({ ready: true });
    setInterval(() => store.list(), 1000);
  `, f.path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  f.children.push(child);
  const [ready] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('Lease owner exited before becoming ready'); }),
  ]);
  assert.deepEqual(ready, { ready: true });
  assert.throws(() => f.store.acquireLease('contender'), /already owns/);
  await terminate(child);
  f.metadata(db => {
    assert.equal(db.prepare('SELECT owner FROM daemon_lease').get()?.owner, 'sqlite-lock:child-owner');
    db.prepare('UPDATE daemon_lease SET pid=?').run(process.pid);
  });
  f.store.acquireLease('recovered');
  const other = f.open();
  assert.throws(() => other.acquireLease('third'), /already owns/);
  f.store.releaseLease('recovered');
});

test('daemon listen failure releases ownership for a subsequent start', async t => {
  const f = fixture(t);
  const dispatcher: Dispatcher = {
    ready: async () => {}, close: async () => {},
    dispatch: async () => ({ sessionId: 'unused', queuedSubmissionId: 'unused' }),
  };
  const blocker = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(startServer(f.dir, { port: address.port, dispatcher }), { code: 'EADDRINUSE' });
  } finally {
    await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
  }
  const daemon = await startServer(f.dir, { port: 0, dispatcher });
  try { assert.equal(daemon.status().running, true); }
  finally { await daemon.close(); }
});
