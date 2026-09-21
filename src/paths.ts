import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const configSchema = z.object({ token: z.string().min(32), port: z.number().int().min(1).max(65535), codex: z.string().min(1) });
export type Config = z.infer<typeof configSchema>;
export function dataDirectory(value?: string): string {
  const dir = resolve(value ?? process.env.CODEX_SCHEDULE_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'codex-cli-schedule'));
  const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  if ([homedir(), parse(dir).root].some(path => normalize(resolve(path)) === normalize(dir))) {
    throw new Error('Choose a dedicated scheduler data subdirectory instead of a user home or filesystem root.');
  }
  return dir;
}
export function readConfig(dir: string): Config {
  return configSchema.parse(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')));
}
export function ensureConfig(dir: string): Config {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { return readConfig(dir); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const config: Config = { token: randomBytes(32).toString('hex'), port: 47632, codex: process.env.CODEX_SCHEDULE_CODEX ?? 'codex' };
    try { writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 }); }
    catch (createError: any) { if (createError.code !== 'EEXIST') throw createError; }
    return readConfig(dir);
  }
}
export function saveConfig(dir: string, config: Config): void {
  const temp = join(dir, `config.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temp, join(dir, 'config.json'));
}
