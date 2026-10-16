import { z } from 'zod';
import { config } from '../../config.js';
import { calls } from '../../db/repo.js';
import { isE164, scheduleAssistantCall } from '../../integrations/telnyx.js';
import { enqueue } from '../../jobs/queue.js';
import { defineTool, type ToolSpec } from './spec.js';

const phoneReady = () => {
  const t = config().telnyx;
  return Boolean(t.apiKey && t.conciergeAssistantId && t.phoneNumber);
};

export const phoneTools: ToolSpec[] = [
  defineTool({
    name: 'call_business',
    label: 'Placing a call',
    description:
      'Have your voice agent phone a business on the user’s behalf (book a table, make or move an appointment, ask a question, query a bill). It introduces itself as an AI assistant calling for the user and reports back with the outcome. Needs the user’s approval. Find the number with web_search first. Never use it to call private individuals.',
    input: z.object({
      phone_number: z.string().describe('E.164 format, e.g. +14155550123'),
      business_name: z.string().min(1),
      objective: z.string().min(5).describe('What the call must achieve, e.g. "Book a table for 4 on Friday 24 Oct at 7:30pm"'),
      details: z.string().optional().describe('Facts the caller may share: name for the booking, acceptable alternatives, constraints'),
      max_minutes: z.number().int().min(1).max(15).optional(),
    }),
    available: phoneReady,
    approval: (i) => `Call ${i.business_name} at ${i.phone_number} to: ${i.objective}${i.details ? `\nDetails I'll share: ${i.details}` : ''}`,
    run: async (i, ctx) => {
      if (!isE164(i.phone_number)) throw new Error('The phone number must be in international E.164 format, e.g. +14155550123');
      const t = config().telnyx;
      const call = await calls.create(ctx.user.id, {
        direction: 'outbound',
        to: i.phone_number,
        from: t.phoneNumber,
        objective: i.objective,
        meta: { business: i.business_name, details: i.details ?? null, max_minutes: i.max_minutes ?? 8, channel: ctx.channel },
      });
      const scheduled = await scheduleAssistantCall({
        assistantId: t.conciergeAssistantId!,
        to: i.phone_number,
        at: new Date(Date.now() + 20_000),
        metadata: { ta_call_id: call.id, business: i.business_name },
      });
      await calls.update(call.id, { status: 'scheduled', providerCallId: scheduled.scheduled_event_id, meta: { conversation_id: scheduled.conversation_id ?? null } });
      await enqueue('call-watch', { callId: call.id, attempt: 0 }, { startAfterSeconds: 90 });
      ctx.activity.push({ tool: 'call_business', summary: `Calling ${i.business_name}` });
      return { status: 'calling', message: `Calling ${i.business_name} now. I'll message you with what happens.` };
    },
  }),
];
