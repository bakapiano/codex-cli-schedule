import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { nextRun, type ScheduleInput } from '../src/model.js';
import { Scheduler } from '../src/scheduler.js';
import { TransportError, type Dispatcher } from '../src/codex.js';
import { dataDirectory } from '../src/paths.js';

const base = (patch: Partial<ScheduleInput> = {}): ScheduleInput => ({ name: 'test', prompt: 'Reply TEST_OK', enabled: true, trigger: { type: 'every', seconds: 10 }, target: { type: 'existing', sessionId: randomUUID() }, ...patch });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-schedule-test-'));
  const path = join(dir, 'db.sqlite');
  const store = new Store(path);
  return { dir, path, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('at, every, cron and timezone semantics', () => {
  const now = new Date('2026-09-21T08:00:00Z');
  assert.equal(nextRun({ type: 'at', at: '2026-09-21T18:00:00+08:00' }, now, true), '2026-09-21T10:00:00.000Z');
  assert.equal(nextRun({ type: 'at', at: '2026-09-21T18:00:00+08:00' }, now, false), null);
  assert.equal(nextRun({ type: 'every', seconds: 60 }, now, true), '2026-09-21T08:01:00.000Z');
  assert.equal(nextRun({ type: 'cron', expression: '0 18 * * *', timezone: 'Asia/Shanghai' }, now, true), '2026-09-21T10:00:00.000Z');
  assert.throws(() => nextRun({ type: 'at', at: now.toISOString() }, now, true), /future/);
  assert.throws(() => nextRun({ type: 'cron', expression: 'invalid', timezone: 'UTC' }, now, true));
});

test('CRUD, pause/resume, optimistic update and durable storage', () => {
  const f = fixture();
  try {
    const now = new Date('2026-09-21T08:00:00Z');
    const task = f.store.create(base(), now);
    assert.equal(f.store.list().length, 1);
    const paused = f.store.update(task.id, { enabled: false }, 1, now);
    assert.equal(paused.nextRunAt, null);
    assert.throws(() => f.store.update(task.id, { name: 'race' }, 1), /version/);
    const renamed = f.store.update(task.id, { name: 'renamed' }, 2, now);
    assert.equal(renamed.enabled, false);
    const resumed = f.store.update(task.id, { enabled: true }, undefined, now);
    assert.equal(resumed.nextRunAt, '2026-09-21T08:00:10.000Z');
    const another = new Store(f.path);
    assert.equal(another.get(task.id).name, 'renamed');
    another.close();
    f.store.delete(task.id);
    assert.deepEqual(f.store.list(), []);
    assert.throws(() => f.store.get(task.id), /not found/);
  } finally { f.cleanup(); }
});

test('validation rejects missing timezone, invalid session and unknown properties', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.create(base({ trigger: { type: 'at', at: '2099-01-01T12:00:00' } })));
    assert.throws(() => f.store.create(base({ trigger: { type: 'at', at: '2099-02-30T12:00:00Z' } })));
    assert.throws(() => f.store.create(base({ target: { type: 'existing', sessionId: 'oops' } })));
    assert.throws(() => f.store.create({ ...base(), surprising: true }));
    assert.throws(() => f.store.create(base({ target: { type: 'new', cwd: 'relative/path' } })));
  } finally { f.cleanup(); }
});

test('data directory is a dedicated subdirectory', () => {
  assert.throws(() => dataDirectory(homedir()), /dedicated/);
  assert.throws(() => dataDirectory(parse(process.cwd()).root), /dedicated/);
  assert.equal(dataDirectory(join(tmpdir(), 'schedule-data')), join(tmpdir(), 'schedule-data'));
});

test('atomic claim coalesces missed intervals and recovery marks uncertain runs', () => {
  const f = fixture();
  try {
    const start = new Date('2026-09-21T08:00:00Z');
    const task = f.store.create(base(), start);
    const later = new Date('2026-09-21T09:00:00Z');
    const claim = f.store.claim(later)!;
    assert.equal(claim.schedule.id, task.id);
    assert.equal(f.store.claim(later), null);
    assert.equal(f.store.get(task.id).nextRunAt, '2026-09-21T09:00:10.000Z');
    assert.equal(f.store.recoverInterrupted(later), 1);
    assert.equal(f.store.runs(task.id)[0]?.status, 'unknown');
    f.store.delete(task.id);
    assert.equal(f.store.runs(task.id).length, 1);
  } finally { f.cleanup(); }
});

test('one-shot fires once and becomes disabled', () => {
  const f = fixture();
  try {
    const task = f.store.create(base({ trigger: { type: 'at', at: '2026-09-21T08:01:00Z' } }), new Date('2026-09-21T08:00:00Z'));
    assert.ok(f.store.claim(new Date('2026-09-22T08:00:00Z')));
    assert.equal(f.store.get(task.id).enabled, false);
    assert.equal(f.store.claim(new Date('2026-09-22T08:00:00Z')), null);
  } finally { f.cleanup(); }
});

test('daemon lease allows a single owner across database connections', () => {
  const f = fixture();
  const other = new Store(f.path);
  try {
    f.store.acquireLease('first');
    assert.throws(() => other.acquireLease('second'), /already owns/);
    other.releaseLease('wrong-owner');
    assert.throws(() => other.acquireLease('second'), /already owns/);
    f.store.releaseLease('first');
    other.acquireLease('second');
    other.releaseLease('second');
  } finally { other.close(); f.cleanup(); }
});

test('scheduler serializes concurrent ticks and records queue acknowledgement', async () => {
  const f = fixture();
  let now = new Date('2026-09-21T08:00:00Z');
  let sent = 0;
  const dispatcher: Dispatcher = {
    ready: async () => {}, close: async () => {},
    dispatch: async (_schedule, _run, onCreated) => {
      sent++; onCreated('new-session');
      await new Promise(resolve => setTimeout(resolve, 10));
      return { sessionId: 'new-session', queuedSubmissionId: 'q1' };
    },
  };
  const scheduler = new Scheduler(f.store, dispatcher, () => now);
  try {
    const task = f.store.create(base(), now);
    now = new Date('2026-09-21T08:00:10Z');
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    assert.equal(sent, 1);
    assert.equal(f.store.runs(task.id)[0]?.status, 'queued');
    assert.equal(f.store.runs(task.id)[0]?.sessionId, 'new-session');
  } finally { await scheduler.stop(); f.cleanup(); }
});

test('preflight failure leaves due schedules pending; uncertain dispatch is recorded once', async () => {
  const f = fixture();
  let now = new Date('2026-09-21T08:00:00Z');
  let available = false;
  const dispatcher: Dispatcher = {
    ready: async () => { if (!available) throw new Error('offline'); }, close: async () => {},
    dispatch: async () => { throw new TransportError('acknowledgement lost'); },
  };
  const scheduler = new Scheduler(f.store, dispatcher, () => now);
  try {
    const task = f.store.create(base({ trigger: { type: 'at', at: '2026-09-21T08:00:01Z' } }), now);
    now = new Date('2026-09-21T08:00:02Z');
    await scheduler.tick();
    assert.equal(f.store.runs().length, 0);
    assert.equal(f.store.get(task.id).enabled, true);
    available = true;
    now = new Date('2026-09-21T08:00:08Z');
    await scheduler.tick();
    assert.equal(f.store.runs()[0]?.status, 'unknown');
    await scheduler.tick();
    assert.equal(f.store.runs().length, 1);
  } finally { await scheduler.stop(); f.cleanup(); }
});
