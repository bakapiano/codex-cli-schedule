import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import type { Schedule } from './model.js';

// The scheduler's protocol surface intentionally contains no execution or resume methods.
export type Method = 'initialize' | 'thread/start' | 'thread/read' | 'thread/list' | 'thread/inject_items' | 'thread/queue/add';
export class TransportError extends Error {}
export class RpcError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}
export interface Rpc {
  request<T>(method: Method, params: unknown): Promise<T>;
  close(): Promise<void>;
}
export interface Delivery { sessionId: string; queuedSubmissionId: string }
export interface Dispatcher {
  ready(): Promise<void>;
  dispatch(schedule: Schedule, runId: string, onCreated: (id: string) => void): Promise<Delivery>;
  close(): Promise<void>;
}

export class StdioRpc implements Rpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private nextId = 0;
  private stopped = false;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(command: string, args = ['app-server', '--stdio'], private readonly timeoutMs = 30_000) {
    const env = { ...process.env };
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SESSION_ID;
    this.child = spawn(command, args, { stdio: 'pipe', windowsHide: true, env });
    this.child.stdin.on('error', () => {});
    // Drain diagnostics without writing protocol data or potentially sensitive arguments to logs.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        this.write({ id: message.id, error: { code: -32601, message: 'Queue-only scheduler client' } });
        return;
      }
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new RpcError(message.error.code, message.error.message));
      else item.resolve(message.result);
    });
    this.exited = new Promise(resolve => {
      this.child.once('error', error => { this.fail(new TransportError(`Could not start Codex App Server: ${error.message}`)); resolve(); });
      this.child.once('exit', code => { this.fail(new TransportError(`Codex App Server exited (${code}).`)); lines.close(); resolve(); });
    });
  }
  private fail(error: Error): void {
    this.stopped = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  private write(message: unknown): void {
    if (!this.stopped) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'codex_cli_schedule', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
  }
  request<T>(method: Method, params: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(new TransportError('Codex App Server connection is closed.'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new TransportError(`${method}: response timed out; delivery may be uncertain.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}

export type RpcFactory = () => Promise<Rpc>;
export function rpcFactory(command: string): RpcFactory {
  return async () => {
    const rpc = new StdioRpc(command);
    try { await rpc.initialize(); return rpc; }
    catch (error) { await rpc.close(); throw error; }
  };
}

export class CodexDispatcher implements Dispatcher {
  private rpc?: Rpc;
  constructor(private readonly connect: RpcFactory) {}
  async ready(): Promise<void> { this.rpc ??= await this.connect(); }
  async close(): Promise<void> { const rpc = this.rpc; this.rpc = undefined; await rpc?.close(); }
  async dispatch(schedule: Schedule, runId: string, onCreated: (id: string) => void): Promise<Delivery> {
    await this.ready();
    try {
      let sessionId: string;
      if (schedule.target.type === 'existing') {
        sessionId = schedule.target.sessionId;
        await this.rpc!.request('thread/read', { threadId: sessionId, includeTurns: false });
      } else {
        if (!(await stat(schedule.target.cwd)).isDirectory()) throw new Error('The new session cwd must be a directory.');
        const result = await this.rpc!.request<{ thread: { id: string } }>('thread/start', {
          cwd: schedule.target.cwd, model: schedule.target.model,
          ephemeral: false, sandbox: 'read-only', approvalPolicy: 'on-request',
        });
        sessionId = result.thread.id;
        onCreated(sessionId);
        // Persist a clearly attributed initialization record without running a turn.
        // Queueing while its creator is loaded would let that owner consume the
        // queued prompt. Release the creator first, then use a queue-only connection.
        await this.rpc!.request('thread/inject_items', {
          threadId: sessionId,
          items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '[codex-cli-schedule] Session initialized. The scheduled prompt will be delivered separately through the queue.' }] }],
        });
        await this.close();
        await this.ready();
      }
      const result = await this.rpc!.request<{ queuedSubmission: { id: string } }>('thread/queue/add', {
        threadId: sessionId, clientUserMessageId: runId,
        input: [{ type: 'text', text: schedule.prompt }],
      });
      if (!result.queuedSubmission?.id) throw new TransportError('Queue acknowledgement did not contain a submission ID.');
      return { sessionId, queuedSubmissionId: result.queuedSubmission.id };
    } finally { await this.close(); }
  }
}
