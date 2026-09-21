import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSchema, nextRun, patchSchema, type ClaimedRun, type Run, type Schedule } from './model.js';

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, document TEXT NOT NULL, next_run_at TEXT);
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_run_at);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
        scheduled_at TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(schedule_id, scheduled_at));
      CREATE INDEX IF NOT EXISTS runs_schedule ON runs(schedule_id, scheduled_at DESC);
      CREATE TABLE IF NOT EXISTS daemon_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, owner TEXT NOT NULL);`);
  }
  close(): void { this.db.close(); }
  acquireLease(owner: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare('SELECT pid FROM daemon_lease WHERE singleton=1').get();
      if (lease) {
        let alive = true;
        try { process.kill(Number(lease.pid), 0); } catch (error: any) { alive = error.code !== 'ESRCH'; }
        if (alive) throw new Error(`A scheduler daemon already owns this data directory (PID ${lease.pid}).`);
      }
      this.db.prepare('INSERT OR REPLACE INTO daemon_lease VALUES(1,?,?)').run(process.pid, owner);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  releaseLease(owner: string): void { this.db.prepare('DELETE FROM daemon_lease WHERE owner=?').run(owner); }
  private save(schedule: Schedule): void {
    this.db.prepare('INSERT OR REPLACE INTO schedules VALUES(?,?,?)').run(schedule.id, JSON.stringify(schedule), schedule.nextRunAt);
  }
  private saveRun(run: Run): void {
    this.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?,?)').run(run.id, run.scheduleId, run.scheduledAt, JSON.stringify(run));
  }
  list(): Schedule[] {
    return this.db.prepare('SELECT document FROM schedules ORDER BY id').all().map(row => JSON.parse(row.document as string) as Schedule);
  }
  get(id: string): Schedule {
    const row = this.db.prepare('SELECT document FROM schedules WHERE id=?').get(id);
    if (!row) throw new Error(`Schedule not found: ${id}`);
    return JSON.parse(row.document as string) as Schedule;
  }
  create(value: unknown, now = new Date()): Schedule {
    const input = createSchema.parse(value);
    const next = nextRun(input.trigger, now, true); // Validate even when initially paused.
    const schedule: Schedule = { ...input, id: randomUUID(), version: 1, nextRunAt: input.enabled ? next : null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    this.save(schedule);
    return schedule;
  }
  update(id: string, value: unknown, expectedVersion?: number, now = new Date()): Schedule {
    const patch = patchSchema.parse(value);
    const current = this.get(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new Error('Schedule version changed; read it again before updating.');
    const input = createSchema.parse({ name: current.name, prompt: current.prompt, trigger: current.trigger, target: current.target, enabled: current.enabled, ...patch });
    const resetTime = patch.trigger !== undefined || (patch.enabled === true && !current.enabled);
    const next = resetTime ? nextRun(input.trigger, now, true) : current.nextRunAt;
    const schedule: Schedule = { ...current, ...input, nextRunAt: input.enabled ? next : null, version: current.version + 1, updatedAt: now.toISOString() };
    this.save(schedule);
    return schedule;
  }
  delete(id: string): { deleted: string; inFlight: boolean } {
    this.get(id);
    const inFlight = this.runs(id).some(run => run.status === 'dispatching');
    this.db.prepare('DELETE FROM schedules WHERE id=?').run(id);
    return { deleted: id, inFlight };
  }
  runs(scheduleId?: string, limit = 100): Run[] {
    const rows = scheduleId
      ? this.db.prepare('SELECT document FROM runs WHERE schedule_id=? ORDER BY scheduled_at DESC LIMIT ?').all(scheduleId, limit)
      : this.db.prepare('SELECT document FROM runs ORDER BY scheduled_at DESC LIMIT ?').all(limit);
    return rows.map(row => JSON.parse(row.document as string) as Run);
  }
  due(now = new Date()): boolean {
    return !!this.db.prepare('SELECT id FROM schedules WHERE next_run_at<=? LIMIT 1').get(now.toISOString());
  }
  claim(now = new Date()): ClaimedRun | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT document FROM schedules WHERE next_run_at<=? ORDER BY next_run_at LIMIT 1').get(now.toISOString());
      if (!row) { this.db.exec('COMMIT'); return null; }
      const schedule = JSON.parse(row.document as string) as Schedule;
      const run: Run = { id: randomUUID(), scheduleId: schedule.id, scheduledAt: schedule.nextRunAt!, startedAt: now.toISOString(), finishedAt: null, status: 'dispatching', sessionId: null, queuedSubmissionId: null, error: null };
      this.saveRun(run);
      const next = nextRun(schedule.trigger, now, false);
      this.save({ ...schedule, nextRunAt: next, enabled: next !== null, updatedAt: now.toISOString(), version: schedule.version + 1 });
      this.db.exec('COMMIT');
      return { schedule, run };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  updateRun(id: string, patch: Partial<Pick<Run, 'status' | 'sessionId' | 'queuedSubmissionId' | 'error' | 'finishedAt'>>): Run {
    const row = this.db.prepare('SELECT document FROM runs WHERE id=?').get(id);
    if (!row) throw new Error(`Run not found: ${id}`);
    const run = { ...JSON.parse(row.document as string) as Run, ...patch };
    this.saveRun(run);
    return run;
  }
  recoverInterrupted(now = new Date()): number {
    const rows = this.db.prepare('SELECT document FROM runs').all();
    let count = 0;
    for (const row of rows) {
      const run = JSON.parse(row.document as string) as Run;
      if (run.status === 'dispatching') {
        this.saveRun({ ...run, status: 'unknown', error: 'Daemon stopped during dispatch. Verify the session queue before scheduling another delivery.', finishedAt: now.toISOString() });
        count++;
      }
    }
    return count;
  }
}
