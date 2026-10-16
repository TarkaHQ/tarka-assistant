import { z } from 'zod';
import { lists } from '../../db/repo.js';
import { defineTool, type ToolSpec } from './spec.js';

export const listTools: ToolSpec[] = [
  defineTool({
    name: 'list_add',
    label: 'Updating your list',
    description: 'Add items to one of the user’s lists (groceries, packing, to-do, gift ideas…). Creates the list if needed.',
    input: z.object({
      list: z.string().min(1).describe('List name, e.g. "groceries"'),
      items: z.array(z.string().min(1)).min(1).max(50),
    }),
    run: async ({ list, items }, ctx) => {
      const added = await lists.add(ctx.user.id, list, items);
      const now = await lists.items(ctx.user.id, list);
      ctx.activity.push({ tool: 'list_add', summary: `Added ${added} to ${lists.normalise(list)}` });
      return { list: lists.normalise(list), added, open_items: now.filter((i) => !i.done).map((i) => i.text) };
    },
  }),

  defineTool({
    name: 'list_show',
    label: 'Reading your list',
    description: 'Show a list’s items, or all the user’s lists when no name is given.',
    input: z.object({ list: z.string().optional() }),
    run: async ({ list }, ctx) => {
      if (!list) return { lists: await lists.all(ctx.user.id) };
      const items = await lists.items(ctx.user.id, list);
      return { list: lists.normalise(list), open: items.filter((i) => !i.done).map((i) => i.text), done: items.filter((i) => i.done).map((i) => i.text) };
    },
  }),

  defineTool({
    name: 'list_remove',
    label: 'Updating your list',
    description: 'Remove items from a list, or tick them off (done=true) so they stay visible as completed.',
    input: z.object({ list: z.string().min(1), items: z.array(z.string().min(1)).min(1), done: z.boolean().optional() }),
    run: async ({ list, items, done }, ctx) => {
      const affected = await lists.remove(ctx.user.id, list, items, Boolean(done));
      return { list: lists.normalise(list), [done ? 'ticked' : 'removed']: affected };
    },
  }),

  defineTool({
    name: 'list_delete',
    label: 'Deleting a list',
    description: 'Delete a whole list.',
    input: z.object({ list: z.string().min(1) }),
    run: async ({ list }, ctx) => {
      await lists.clear(ctx.user.id, list);
      return { deleted: lists.normalise(list) };
    },
  }),
];
