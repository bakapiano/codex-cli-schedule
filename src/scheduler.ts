import { TransportError, type Dispatcher } from './codex.js';
import { errorMessage } from './model.js';
import type { Store } from './store.js';

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping = false;
  private retryAfter = 0;
  lastError: string | null = null;
  constructor(private readonly store: Store, private readonly dispatcher: Dispatcher, private readonly clock = () => new Date()) {}
  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, 500);
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.stopping || this.clock().getTime() < this.retryAfter || !this.store.due(this.clock())) return Promise.resolve();
    this.active = this.execute().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async execute(): Promise<void> {
    try {
      // Connection failures before claiming leave due tasks pending for a later attempt.
      await this.dispatcher.ready();
      const claimed = this.store.claim(this.clock());
      if (!claimed) return;
      try {
        const delivered = await this.dispatcher.dispatch(claimed.schedule, claimed.run.id, id => {
          this.store.updateRun(claimed.run.id, { sessionId: id });
        });
        this.store.updateRun(claimed.run.id, { ...delivered, status: 'queued', finishedAt: this.clock().toISOString() });
        this.lastError = null;
      } catch (error) {
        this.lastError = errorMessage(error);
        this.store.updateRun(claimed.run.id, { status: error instanceof TransportError ? 'unknown' : 'failed', error: this.lastError, finishedAt: this.clock().toISOString() });
      }
    } catch (error) {
      this.lastError = errorMessage(error);
      this.retryAfter = this.clock().getTime() + 5000;
    } finally { await this.dispatcher.close(); }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.active;
    await this.dispatcher.close();
  }
}
