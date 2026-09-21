import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { CodexDispatcher, rpcFactory, type Dispatcher } from './codex.js';
import { ensureConfig, saveConfig, type Config } from './paths.js';
import { errorMessage } from './model.js';
import { validateOperation } from './operations.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';

async function body(request: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error('Request body exceeds 1 MiB.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
export async function startServer(dir: string, options: { port?: number; codex?: string; dispatcher?: Dispatcher } = {}) {
  const current = ensureConfig(dir);
  const config: Config = { ...current, codex: options.codex ?? current.codex };
  const store = new Store(join(dir, 'schedules.sqlite'));
  const owner = randomUUID();
  try { store.acquireLease(owner); } catch (error) { store.close(); throw error; }
  const dispatcher = options.dispatcher ?? new CodexDispatcher(rpcFactory(config.codex));
  const scheduler = new Scheduler(store, dispatcher);
  const recovered = store.recoverInterrupted();
  const startedAt = new Date().toISOString();
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  const status = () => ({ running: true, pid: process.pid, dataDir: dir, startedAt, recovered, schedules: store.list().length, enabled: store.list().filter(item => item.enabled).length, lastError: scheduler.lastError });
  const server = createServer((request, response) => {
    void (async () => {
      const expected = Buffer.from(`Bearer ${config.token}`);
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { respond(response, 401, { error: 'Authentication required.' }); return; }
      if (request.headers.origin || ![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(request.headers.host ?? '')) { respond(response, 403, { error: 'Loopback command clients only.' }); return; }
      if (request.method === 'GET' && request.url === '/health') { respond(response, 200, { result: status() }); return; }
      if (stopping) { respond(response, 503, { error: 'Scheduler is stopping.' }); return; }
      if (request.method === 'POST' && request.url === '/shutdown') {
        respond(response, 200, { result: { stopping: true } });
        setImmediate(() => { void close(); });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/rpc') { respond(response, 404, { error: 'Unknown endpoint.' }); return; }
      const value = await body(request);
      const operation = validateOperation(value.method, value.args ?? {});
      const args = operation.args;
      let result: unknown;
      switch (operation.name) {
        case 'schedule_create': result = store.create(args); break;
        case 'schedule_list': result = store.list(); break;
        case 'schedule_get': result = store.get(args.id); break;
        case 'schedule_update': result = store.update(args.id, args.patch, args.expectedVersion); break;
        case 'schedule_delete': result = store.delete(args.id); break;
        case 'schedule_runs': result = store.runs(args.scheduleId, args.limit); break;
        case 'scheduler_status': result = status(); break;
      }
      respond(response, 200, { result });
    })().catch(error => { if (!response.headersSent) respond(response, 400, { error: errorMessage(error) }); else response.destroy(); });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    stopping = true;
    closePromise = (async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      await scheduler.stop();
      await closed;
      store.releaseLease(owner);
      store.close();
    })();
    return closePromise;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? current.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine the daemon port.');
    config.port = address.port;
    saveConfig(dir, config);
    scheduler.start();
    return { config, close, store, status };
  } catch (error) {
    server.close();
    store.releaseLease(owner);
    store.close();
    throw error;
  }
}
