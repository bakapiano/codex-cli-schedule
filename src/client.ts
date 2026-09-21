import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureConfig, readConfig, type Config } from './paths.js';
import type { Operation } from './operations.js';

export async function request(config: Config, path: string, body?: unknown, timeoutMs = 5000): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(value.error ?? `Scheduler returned HTTP ${response.status}.`);
  return value.result;
}
export async function daemonStatus(dir: string): Promise<any> { return request(readConfig(dir), '/health', undefined, 1000); }
export async function ensureDaemon(dir: string, options: { port?: number; codex?: string } = {}): Promise<any> {
  ensureConfig(dir);
  try {
    const status = await daemonStatus(dir);
    if (options.port !== undefined || options.codex !== undefined) throw new Error('Daemon is already running. Stop it before changing startup options.');
    return status;
  } catch (error: any) {
    if (error.message?.startsWith('Daemon is already running.')) throw error;
  }
  const output = openSync(join(dir, 'daemon.log'), 'a', 0o600);
  const args = [fileURLToPath(new URL('./cli.js', import.meta.url)), '--home', dir, 'serve'];
  if (options.port !== undefined) args.push('--port', String(options.port));
  if (options.codex !== undefined) args.push('--codex', options.codex);
  let spawnError: Error | undefined;
  try {
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', output, output], env: process.env });
    child.once('error', error => { spawnError = error; });
    child.unref();
  } finally { closeSync(output); }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    await new Promise(resolve => setTimeout(resolve, 100));
    try { return await daemonStatus(dir); } catch {}
  }
  throw new Error(`Scheduler startup failed. Inspect ${join(dir, 'daemon.log')}.`);
}
export async function call(dir: string, method: Operation, args: unknown): Promise<any> {
  await ensureDaemon(dir);
  return request(readConfig(dir), '/rpc', { method, args });
}
