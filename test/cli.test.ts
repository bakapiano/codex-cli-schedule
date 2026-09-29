import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

test('CLI reports the package version from another working directory', () => {
  const output = execFileSync(process.execPath, [cli, '--version'], { cwd: tmpdir(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(output.trim(), version);
});

test('CLI help works from another working directory', () => {
  const output = execFileSync(process.execPath, [cli, '--help'], { cwd: tmpdir(), encoding: 'utf8', timeout: 10_000 });
  assert.match(output, /Usage: codex-schedule/);
  assert.match(output, /mcp/);
});
