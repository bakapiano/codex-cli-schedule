#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { call, daemonStatus, ensureDaemon, request } from './client.js';
import { dataDirectory, readConfig } from './paths.js';
import { errorMessage } from './model.js';

const program = new Command().name('codex-schedule').description('Persistent, queue-only scheduling for Codex CLI sessions').version('0.1.0').option('--home <path>', 'Shared scheduler data directory');
const home = () => dataDirectory(program.opts().home);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
function seconds(value: string): number {
  const match = /^(\d+)(s|m|h|d)?$/.exec(value);
  if (!match) throw new Error('Use a duration such as 30s, 5m, 2h, or 1d.');
  return Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's'] ?? 1);
}
function scheduleOptions(command: Command): Command {
  return command.option('--json <json-or-@file>', 'Schedule or patch JSON')
    .option('--name <name>').option('--prompt <text>').option('--prompt-file <path>')
    .option('--at <timestamp>', 'One-time ISO timestamp with timezone').option('--every <duration>', 'Interval: 30s, 5m, 2h').option('--cron <expression>').option('--timezone <iana>', 'Cron timezone, default UTC')
    .option('--session <uuid>', 'Queue into an existing session').option('--new', 'Create and release a new session before queueing').option('--cwd <path>', 'Absolute cwd for new sessions').option('--model <model>', 'Model for new sessions')
    .option('--pause', 'Pause the schedule').option('--enable', 'Enable the schedule');
}
function scheduleInput(options: any): any {
  const result = options.json ? JSON.parse(options.json.startsWith('@') ? readFileSync(options.json.slice(1), 'utf8') : options.json) : {};
  if ([options.at, options.every, options.cron].filter(Boolean).length > 1) throw new Error('Choose one trigger: --at, --every, or --cron.');
  if (options.session && options.new) throw new Error('Choose one target: --session or --new.');
  if (options.pause && options.enable) throw new Error('Choose --pause or --enable.');
  if (options.prompt && options.promptFile) throw new Error('Choose --prompt or --prompt-file.');
  if (options.name !== undefined) result.name = options.name;
  if (options.prompt !== undefined) result.prompt = options.prompt;
  if (options.promptFile !== undefined) result.prompt = readFileSync(options.promptFile, 'utf8');
  if (options.at) result.trigger = { type: 'at', at: options.at };
  if (options.every) result.trigger = { type: 'every', seconds: seconds(options.every) };
  if (options.cron) result.trigger = { type: 'cron', expression: options.cron, timezone: options.timezone ?? 'UTC' };
  if (options.session) result.target = { type: 'existing', sessionId: options.session };
  if (options.new) result.target = { type: 'new', cwd: options.cwd, ...(options.model ? { model: options.model } : {}) };
  if (options.pause) result.enabled = false;
  if (options.enable) result.enabled = true;
  return result;
}
program.command('start').option('--port <port>').option('--codex <executable>').action(async options => { print(await ensureDaemon(home(), { port: options.port === undefined ? undefined : Number(options.port), codex: options.codex })); });
program.command('serve').description('Run the daemon in the foreground').option('--port <port>').option('--codex <executable>').action(async options => {
  const { startServer } = await import('./daemon.js');
  const port = options.port === undefined ? undefined : Number(options.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('Port must be between 0 and 65535.');
  const server = await startServer(home(), { port, codex: options.codex });
  process.once('SIGINT', () => { void server.close(); });
  process.once('SIGTERM', () => { void server.close(); });
  console.error(`Scheduler listening on 127.0.0.1:${server.config.port}; PID ${process.pid}`);
});
program.command('stop').action(async () => { print(await request(readConfig(home()), '/shutdown', {})); });
program.command('status').action(async () => {
  try { print(await daemonStatus(home())); } catch { print({ running: false, dataDir: home() }); }
});
program.command('mcp').description('Run the lightweight stdio MCP management endpoint').action(async () => { const { runMcp } = await import('./mcp.js'); await runMcp(home()); });
scheduleOptions(program.command('create').alias('add')).action(async options => { print(await call(home(), 'schedule_create', scheduleInput(options))); });
program.command('list').action(async () => { print(await call(home(), 'schedule_list', {})); });
program.command('get <id>').action(async id => { print(await call(home(), 'schedule_get', { id })); });
scheduleOptions(program.command('update <id>')).option('--version <number>', 'Expected schedule version').action(async (id, options) => { print(await call(home(), 'schedule_update', { id, patch: scheduleInput(options), expectedVersion: options.version === undefined ? undefined : Number(options.version) })); });
program.command('delete <id>').action(async id => { print(await call(home(), 'schedule_delete', { id })); });
program.command('runs [id]').option('--limit <number>', 'Maximum records', '100').action(async (id, options) => { print(await call(home(), 'schedule_runs', { scheduleId: id, limit: Number(options.limit) })); });
program.parseAsync().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
