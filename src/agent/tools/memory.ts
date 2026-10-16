import { z } from 'zod';
import { memory } from '../../memory/hindsight.js';
import { defineTool, type ToolSpec } from './spec.js';
import { config } from '../../config.js';

export const memoryTools: ToolSpec[] = [
  defineTool({
    name: 'memory_search',
    label: 'Checking my memory',
    description:
      'Search long-term memory about the user (people, preferences, plans, past conversations and outcomes). Relevant memories are already in your instructions; use this for anything more specific or older.',
    input: z.object({ query: z.string().min(2).describe('What to look for, phrased as a question or keywords') }),
    available: () => config().memory.enabled,
    run: async ({ query }, ctx) => {
      const items = await memory.search(ctx.user, query);
      return { memories: items.slice(0, 15).map((m) => ({ id: m.id, text: m.text, when: m.when })) };
    },
  }),

  defineTool({
    name: 'remember',
    label: 'Saving to memory',
    description:
      'Save an important fact to long-term memory right away (conversations are also saved automatically). Use when the user says "remember…", gives a durable preference, or after you complete something worth recalling later.',
    input: z.object({
      fact: z.string().min(3).describe('A self-contained statement, e.g. "Priya (the user’s sister) is allergic to peanuts"'),
    }),
    available: () => config().memory.enabled,
    run: async ({ fact }, ctx) => {
      await memory.remember(ctx.user, fact);
      ctx.activity.push({ tool: 'remember', summary: `Remembered: ${fact}` });
      return { saved: true };
    },
  }),

  defineTool({
    name: 'memory_forget',
    label: 'Forgetting',
    description:
      'Forget specific memories when the user asks you to, or when a memory is wrong. Call memory_search first to get the ids, then pass only the ids that match what the user wants forgotten.',
    input: z.object({ memory_ids: z.array(z.string()).min(1).max(20) }),
    available: () => config().memory.enabled,
    run: async ({ memory_ids }, ctx) => {
      const results = await Promise.allSettled(memory_ids.map((id) => memory.forget(ctx.user, id, 'forgotten at the user’s request')));
      const forgotten = results.filter((r) => r.status === 'fulfilled').length;
      ctx.activity.push({ tool: 'memory_forget', summary: `Forgot ${forgotten} memor${forgotten === 1 ? 'y' : 'ies'}` });
      return { forgotten, failed: results.length - forgotten };
    },
  }),

  defineTool({
    name: 'memory_reflect',
    label: 'Thinking about what I know',
    description:
      'Ask your memory a broad question that needs reasoning across many memories, e.g. "What do I know about the user’s travel preferences?" or "What has the user been worried about lately?". Slower than memory_search.',
    input: z.object({ question: z.string().min(5) }),
    available: () => config().memory.enabled,
    run: async ({ question }, ctx) => ({ answer: await memory.reflect(ctx.user, question) }),
  }),
];
