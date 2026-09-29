import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_CODEX_STATE;
const mode = process.env.FAKE_CODEX_MODE;
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const name = args[2];
if (args[0] === 'mcp' && args[1] === 'get') {
  if (mode === 'read-error') { console.error('Configuration parse error'); process.exit(2); }
  if (mode === 'invalid-json') { console.log('{'); process.exit(0); }
  if (mode === 'invalid-structure') { console.log('{"transport":null}'); process.exit(0); }
  if (mode === 'read-error-with-missing-message') { console.error("Error: No MCP server named '" + name + "' found."); process.exit(2); }
  if (!state[name]) { console.error("Error: No MCP server named '" + name + "' found."); process.exit(1); }
  console.log(JSON.stringify(state[name]));
} else if (args[0] === 'mcp' && args[1] === 'add' && args[3] === '--') {
  if (mode === 'write-error') { console.error('Permission denied'); process.exit(7); }
  state[name] = { name, enabled: true, transport: { type: 'stdio', command: mode === 'mismatch' ? 'wrong-node' : args[4], args: args.slice(5) } };
  fs.writeFileSync(file, JSON.stringify(state));
  console.log('Added MCP server');
} else { console.error('Unexpected arguments'); process.exit(9); }
`;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-schedule-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tools = join(dir, 'Codex tools');
  mkdirSync(tools);
  const state = join(dir, 'mcp.json');
  const log = join(dir, 'calls.jsonl');
  const dataDir = join(dir, 'scheduler data & (local) 中文 100%');
  const codex = join(tools, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    writeFileSync(join(tools, 'fake-codex.cjs'), fakeCodex);
    writeFileSync(codex, `@"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`);
  } else {
    writeFileSync(codex, fakeCodex, { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: tools + delimiter + (process.env.PATH ?? ''),
    CODEX_HOME: join(dir, 'isolated-codex'),
    CODEX_SCHEDULE_CODEX: undefined,
    FAKE_CODEX_STATE: state,
    FAKE_CODEX_LOG: log,
    FAKE_CODEX_MODE: undefined,
  };
  const run = (args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [cli, '--home', dataDir, 'setup', ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15_000 });
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const readState = () => JSON.parse(readFileSync(state, 'utf8'));
  const seed = (value: unknown) => writeFileSync(state, JSON.stringify(value));
  return { dir, state, log, dataDir, codex, run, calls, readState, seed };
}

test('setup preview resolves this installation and data directory without running Codex', t => {
  const f = fixture(t);
  const output = f.run(['--dry-run', '--codex', join(f.dir, 'missing.exe')]);
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), {
    status: 'preview', name: 'codex_schedule', command: process.execPath,
    args: [cli, '--home', f.dataDir, 'mcp'],
  });
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(f.state), false);
  assert.equal(existsSync(f.dataDir), false);
});

test('setup finds Codex on PATH, preserves quoted arguments and other servers, and is idempotent', t => {
  const f = fixture(t);
  const other = { name: 'other', enabled: true, transport: { type: 'streamable_http', url: 'https://example.invalid/mcp' } };
  f.seed({ other });
  const output = f.run();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).status, 'configured');
  assert.deepEqual(f.readState().codex_schedule.transport, { type: 'stdio', command: process.execPath, args: [cli, '--home', f.dataDir, 'mcp'] });
  assert.deepEqual(f.readState().other, other);
  const saved = readFileSync(f.state, 'utf8');
  const again = f.run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).status, 'unchanged');
  assert.equal(readFileSync(f.state, 'utf8'), saved);
  assert.equal(f.calls().filter(args => args[1] === 'add').length, 1);
  assert.equal(existsSync(f.dataDir), false);
});

test('setup accepts a custom name and explicit Codex executable path containing spaces', t => {
  const f = fixture(t);
  const output = f.run(['--name', 'my_scheduler', '--codex', f.codex]);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).name, 'my_scheduler');
  assert.ok(f.readState().my_scheduler);
  assert.equal(f.readState().codex_schedule, undefined);
});

test('setup protects conflicting registrations and allows explicit replacement', t => {
  const f = fixture(t);
  const existing = { name: 'codex_schedule', enabled: true, transport: { type: 'streamable_http', url: 'https://example.invalid/mcp', bearer_token_env_var: 'KEEP_PRIVATE' } };
  f.seed({ codex_schedule: existing, other: { keep: true } });
  const rejected = f.run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /different configuration.*--force/);
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /KEEP_PRIVATE/);
  assert.deepEqual(f.readState().codex_schedule, existing);
  assert.equal(f.calls().filter(args => args[1] === 'add').length, 0);
  const accepted = f.run(['--force']);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).status, 'configured');
  assert.equal(f.readState().codex_schedule.transport.type, 'stdio');
  assert.deepEqual(f.readState().other, { keep: true });
});

test('setup treats a disabled matching registration as a conflict', t => {
  const f = fixture(t);
  f.seed({ codex_schedule: { enabled: false, transport: { type: 'stdio', command: process.execPath, args: [cli, '--home', f.dataDir, 'mcp'] } } });
  const output = f.run();
  assert.equal(output.status, 1);
  assert.match(output.stderr, /different configuration/);
  assert.equal(f.readState().codex_schedule.enabled, false);
});

for (const mode of ['read-error', 'invalid-json', 'invalid-structure', 'read-error-with-missing-message']) {
  test(`setup stops on ${mode} even with force`, t => {
    const f = fixture(t);
    const output = f.run(['--force'], { FAKE_CODEX_MODE: mode });
    assert.equal(output.status, 1);
    assert.match(output.stderr, /configuration/);
    assert.equal(f.calls().filter(args => args[1] === 'add').length, 0);
    assert.equal(existsSync(f.state), false);
  });
}

test('setup reports Codex registration failures', t => {
  const f = fixture(t);
  const output = f.run([], { FAKE_CODEX_MODE: 'write-error' });
  assert.equal(output.status, 1);
  assert.match(output.stderr, /registration failed \(exit 7\)/);
  assert.equal(existsSync(f.state), false);
});

test('setup verifies the configuration after Codex accepts registration', t => {
  const f = fixture(t);
  const output = f.run([], { FAKE_CODEX_MODE: 'mismatch' });
  assert.equal(output.status, 1);
  assert.match(output.stderr, /verification failed/);
});

test('setup gives actionable guidance when Codex is missing', t => {
  const f = fixture(t);
  const output = f.run(['--codex', join(f.dir, 'missing-codex.exe')]);
  assert.equal(output.status, 1);
  assert.match(output.stderr, /Could not find Codex CLI.*--codex/);
  assert.deepEqual(f.calls(), []);
});

test('setup validates server names before running Codex', t => {
  const f = fixture(t);
  const output = f.run(['--name', 'bad name & command']);
  assert.equal(output.status, 1);
  assert.match(output.stderr, /MCP server names/);
  assert.deepEqual(f.calls(), []);
});
