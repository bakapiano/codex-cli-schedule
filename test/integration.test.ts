import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../src/daemon.js';
import { request } from '../src/client.js';
import type { Dispatcher } from '../src/codex.js';

test('real MCP stdio process manages a shared daemon and survives client disconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-schedule-mcp-'));
  let delivered = 0;
  const dispatcher: Dispatcher = {
    ready: async () => {}, close: async () => {},
    dispatch: async () => { delivered++; return { sessionId: 'session', queuedSubmissionId: 'queue' }; },
  };
  const daemon = await startServer(dir, { port: 0, dispatcher });
  const client = new Client({ name: 'integration-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--home', dir, 'mcp'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    const created = await client.callTool({ name: 'schedule_create', arguments: { name: 'integration', prompt: 'test', trigger: { type: 'every', seconds: 1 }, target: { type: 'existing', sessionId: randomUUID() } } });
    assert.ok(!created.isError);
    const task = (created.structuredContent as any).result;
    const updated = await client.callTool({ name: 'schedule_update', arguments: { id: task.id, patch: { name: 'changed' }, expectedVersion: task.version } });
    assert.ok(!updated.isError);
    const listed = await client.callTool({ name: 'schedule_list', arguments: {} });
    assert.equal((listed.structuredContent as any).result[0].name, 'changed');
    await client.close();
    for (let i = 0; i < 40 && delivered === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(delivered >= 1);
    const records = await request(daemon.config, '/rpc', { method: 'schedule_runs', args: { scheduleId: task.id } });
    assert.equal(records[0].status, 'queued');
    await request(daemon.config, '/rpc', { method: 'schedule_delete', args: { id: task.id } });
    assert.deepEqual(await request(daemon.config, '/rpc', { method: 'schedule_list', args: {} }), []);
    await assert.rejects(startServer(dir, { port: 0, dispatcher }), /already owns/);
    const unauthorized = await fetch(`http://127.0.0.1:${daemon.config.port}/health`);
    assert.equal(unauthorized.status, 401);
    const origin = await fetch(`http://127.0.0.1:${daemon.config.port}/health`, { headers: { Authorization: `Bearer ${daemon.config.token}`, Origin: 'http://evil.example' } });
    assert.equal(origin.status, 403);
  } finally {
    await client.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
