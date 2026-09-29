import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { dataDirectory } from './paths.js';

export interface SetupOptions {
  name?: string;
  codex?: string;
  home?: string;
  dryRun?: boolean;
  force?: boolean;
}

interface McpConfig {
  enabled?: boolean;
  transport?: { type?: string; command?: string; args?: string[] };
}

export function setupMcp(options: SetupOptions = {}) {
  const name = options.name ?? 'codex_schedule';
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('MCP server names must contain only letters, numbers, underscores, or hyphens.');
  const codex = options.codex ?? process.env.CODEX_SCHEDULE_CODEX ?? 'codex';
  if (!codex.trim()) throw new Error('Choose a Codex CLI executable with --codex <path>.');
  const command = process.execPath;
  const args = [fileURLToPath(new URL('./cli.js', import.meta.url)), '--home', dataDirectory(options.home), 'mcp'];
  const result = { name, command, args };
  if (options.dryRun) return { status: 'preview', ...result };

  const run = (cliArgs: string[]) => {
    const child = spawn.sync(codex, cliArgs, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (child.error) {
      if ((child.error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Could not find Codex CLI (${codex}). Install it on PATH or use setup --codex <path>.`);
      }
      throw new Error(`Could not run Codex CLI: ${child.error.message}`);
    }
    if (child.signal) throw new Error(`Codex CLI was interrupted (${child.signal}).`);
    return child;
  };
  const parse = (text: string): McpConfig => {
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || !('transport' in value)) throw new Error('Missing transport');
      if (!value.transport || typeof value.transport !== 'object' || !('type' in value.transport)
        || typeof value.transport.type !== 'string') throw new Error('Invalid transport');
      return value as McpConfig;
    } catch {
      throw new Error(`Codex returned an invalid MCP configuration. Check it with: codex mcp get ${name} --json`);
    }
  };
  const matches = (config: McpConfig) => config.enabled !== false && config.transport?.type === 'stdio'
    && config.transport.command === command && JSON.stringify(config.transport.args) === JSON.stringify(args);

  const current = run(['mcp', 'get', name, '--json']);
  if (current.status === 0) {
    if (matches(parse(current.stdout))) return { status: 'unchanged', ...result };
    if (!options.force) {
      throw new Error(`MCP server ${name} already has a different configuration. Choose --name <name>, or use --force to replace it.`);
    }
  } else if (current.status !== 1 || !current.stderr.split(/\r?\n/).includes(`Error: No MCP server named '${name}' found.`)) {
    throw new Error(`Could not read Codex MCP configuration (exit ${current.status}). Check it with: codex mcp get ${name} --json`);
  }

  const added = run(['mcp', 'add', name, '--', command, ...args]);
  if (added.status !== 0) throw new Error(`Codex MCP registration failed (exit ${added.status}). Check Codex configuration permissions and retry setup.`);
  const saved = run(['mcp', 'get', name, '--json']);
  if (saved.status !== 0 || !matches(parse(saved.stdout))) {
    throw new Error(`Codex accepted the registration, but verification failed. Inspect it with: codex mcp get ${name} --json`);
  }
  return { status: 'configured', ...result };
}
