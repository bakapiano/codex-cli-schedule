import { isAbsolute } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

const instant = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO-8601 timestamp with Z or an explicit UTC offset.');
const zone = z.string().default('UTC').refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Use a valid IANA timezone.');
export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('at'), at: instant }).strict(),
  z.object({ type: z.literal('every'), seconds: z.number().int().min(1).max(31_536_000) }).strict(),
  z.object({ type: z.literal('cron'), expression: z.string().min(1).max(200), timezone: zone }).strict(),
]);
export const targetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('existing'), sessionId: z.uuid() }).strict(),
  z.object({ type: z.literal('new'), cwd: z.string().refine(isAbsolute, 'cwd must be absolute.'), model: z.string().min(1).optional() }).strict(),
]);
export const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
  trigger: triggerSchema,
  target: targetSchema,
  enabled: z.boolean().default(true),
}).strict();
// A patch must preserve omitted values; creation defaults must not re-enable paused tasks.
export const patchSchema = createSchema.partial().extend({ enabled: z.boolean().optional() });
export type ScheduleInput = z.infer<typeof createSchema>;
export type Trigger = ScheduleInput['trigger'];
export type Target = ScheduleInput['target'];
export type Schedule = ScheduleInput & {
  id: string; version: number; nextRunAt: string | null; createdAt: string; updatedAt: string;
};
export type Run = {
  id: string; scheduleId: string; scheduledAt: string; startedAt: string; finishedAt: string | null;
  status: 'dispatching' | 'queued' | 'failed' | 'unknown';
  sessionId: string | null; queuedSubmissionId: string | null; error: string | null;
};
export type ClaimedRun = { schedule: Schedule; run: Run };

export function nextRun(trigger: Trigger, now: Date, creating: boolean): string | null {
  if (trigger.type === 'at') {
    if (!creating) return null;
    if (Date.parse(trigger.at) <= now.getTime()) throw new Error('The scheduled time must be in the future.');
    return new Date(trigger.at).toISOString();
  }
  if (trigger.type === 'every') return new Date(now.getTime() + trigger.seconds * 1000).toISOString();
  return CronExpressionParser.parse(trigger.expression, { currentDate: now, tz: trigger.timezone }).next().toISOString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
