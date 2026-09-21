import { z } from 'zod';
import { createSchema, patchSchema } from './model.js';

export const operations = [
  { name: 'schedule_create', description: 'Create a persistent schedule. Existing sessions receive queued prompts; new sessions get a labeled initialization record and are released before queueing for a terminal to consume. ISO timestamps require an explicit timezone.', schema: createSchema, readOnly: false },
  { name: 'schedule_list', description: 'List every schedule managed by this local scheduler, including paused and completed schedules.', schema: z.object({}).strict(), readOnly: true },
  { name: 'schedule_get', description: 'Get one schedule and its current version.', schema: z.object({ id: z.uuid() }).strict(), readOnly: true },
  { name: 'schedule_update', description: 'Update a schedule. Set enabled=false to pause it. Timing changes reset the next occurrence. Changes affect future dispatches.', schema: z.object({ id: z.uuid(), patch: patchSchema, expectedVersion: z.number().int().positive().optional() }).strict(), readOnly: false },
  { name: 'schedule_delete', description: 'Delete a schedule and prevent future dispatches. Retains audit records and already queued prompts.', schema: z.object({ id: z.uuid() }).strict(), readOnly: false },
  { name: 'schedule_runs', description: 'List delivery records. queued means the prompt was accepted by the session queue, not that the model has completed it. unknown requires inspection before rescheduling.', schema: z.object({ scheduleId: z.uuid().optional(), limit: z.number().int().min(1).max(1000).default(100) }).strict(), readOnly: true },
  { name: 'scheduler_status', description: 'Get the persistent daemon status and schedule counts.', schema: z.object({}).strict(), readOnly: true },
] as const;
export type Operation = typeof operations[number]['name'];
export function validateOperation(name: string, args: unknown): { name: Operation; args: any } {
  const operation = operations.find(item => item.name === name);
  if (!operation) throw new Error(`Unknown operation: ${name}`);
  return { name: operation.name, args: operation.schema.parse(args) };
}
