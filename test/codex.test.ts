import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CodexDispatcher, type Method, type Rpc, StdioRpc } from '../src/codex.js';
import type { Schedule } from '../src/model.js';

function schedule(target: Schedule['target']): Schedule {
  return { id: randomUUID(), name: 'test', prompt: 'queue me', target, trigger: { type: 'every', seconds: 60 }, enabled: true, version: 1, nextRunAt: null, createdAt: '', updatedAt: '' };
}
test('existing sessions use metadata read and queue insertion only', async () => {
  const events: string[] = [];
  const rpc: Rpc = {
    request: async <T>(method: Method, params: any): Promise<T> => {
      events.push(method);
      if (method === 'thread/queue/add') {
        assert.equal(params.clientUserMessageId, 'stable-run-id');
        assert.equal(params.input[0].text, 'queue me');
        return { queuedSubmission: { id: 'q1' } } as T;
      }
      return {} as T;
    },
    close: async () => { events.push('close'); },
  };
  const dispatcher = new CodexDispatcher(async () => rpc);
  const id = randomUUID();
  assert.deepEqual(await dispatcher.dispatch(schedule({ type: 'existing', sessionId: id }), 'stable-run-id', () => {}), { sessionId: id, queuedSubmissionId: 'q1' });
  assert.deepEqual(events, ['thread/read', 'thread/queue/add', 'close']);
});

test('new session persists a labeled record and releases its writer before queueing', async () => {
  const events: string[] = [];
  let connection = 0;
  const id = randomUUID();
  const dispatcher = new CodexDispatcher(async () => {
    const number = ++connection;
    events.push(`open:${number}`);
    return {
      request: async <T>(method: Method): Promise<T> => {
        events.push(method);
        return (method === 'thread/start' ? { thread: { id } } : { queuedSubmission: { id: 'q2' } }) as T;
      },
      close: async () => { events.push(`closed:${number}`); },
    };
  });
  const result = await dispatcher.dispatch(schedule({ type: 'new', cwd: process.cwd() }), 'run', value => events.push(`created:${value}`));
  assert.equal(result.sessionId, id);
  assert.deepEqual(events, ['open:1', 'thread/start', `created:${id}`, 'thread/inject_items', 'closed:1', 'open:2', 'thread/queue/add', 'closed:2']);
});

test('JSONL stdio transport handles initialization, errors, and graceful EOF', async () => {
  const code = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify(m.method==='thread/read'?{id:m.id,error:{code:-32600,message:'test rejection'}}:{id:m.id,result:{ok:true}}));});`;
  const rpc = new StdioRpc(process.execPath, ['-e', code], 1000);
  try {
    await rpc.initialize();
    assert.deepEqual(await rpc.request('thread/list', {}), { ok: true });
    await assert.rejects(rpc.request('thread/read', {}), /test rejection/);
  } finally { await rpc.close(); }
});

test('transport timeout is reported as uncertain', async () => {
  const rpc = new StdioRpc(process.execPath, ['-e', 'process.stdin.resume()'], 30);
  try { await assert.rejects(rpc.request('thread/list', {}), /timed out/); }
  finally { await rpc.close(); }
});
