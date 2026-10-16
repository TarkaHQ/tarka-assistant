import { tool, type ToolSet } from 'ai';
import type { z } from 'zod';
import type { ChannelName, User } from '../../db/types.js';

/** Everything a tool needs to act for one user. Built fresh for every turn. */
export interface ToolContext {
  user: User;
  channel: ChannelName;
  now: Date;
  /** Sends a short progress note to the user while a long tool runs (e.g. "Calling now…"). */
  progress?: (text: string) => Promise<void>;
  /** Set when executing an approval the user already granted. */
  approved?: boolean;
  /** Collected during the turn: things the user should see on the dashboard activity feed. */
  activity: { tool: string; summary: string }[];
}

export interface ToolSpec<I = any> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** Hidden from the model when false (e.g. Google tools before the user connects Google). */
  available?: (ctx: ToolContext) => boolean;
  /**
   * Returns a one-line, user-facing summary when this call needs the user's explicit approval
   * (it sends, buys, calls or deletes on their behalf), or null when it can run straight away.
   */
  approval?: (input: I, ctx: ToolContext) => string | null | Promise<string | null>;
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
  /** Short label for the dashboard's activity feed and web status line ("Searching the web"). */
  label?: string;
}

export function defineTool<I>(spec: ToolSpec<I>): ToolSpec<I> {
  return spec;
}

export type ApprovalRequester = (spec: ToolSpec, input: unknown, summary: string, ctx: ToolContext) => Promise<Record<string, unknown>>;

/** Converts our specs to AI SDK tools, routing approval-gated calls through `requestApproval`. */
export function toAiTools(specs: ToolSpec[], ctx: ToolContext, requestApproval: ApprovalRequester, onCall?: (name: string, input: unknown) => void): ToolSet {
  const out: ToolSet = {};
  for (const spec of specs) {
    if (spec.available && !spec.available(ctx)) continue;
    out[spec.name] = tool({
      description: spec.description,
      inputSchema: spec.input,
      execute: async (input: unknown) => {
        onCall?.(spec.name, input);
        try {
          const summary = spec.approval ? await spec.approval(input as never, ctx) : null;
          if (summary && !ctx.approved) return await requestApproval(spec, input, summary, ctx);
          return await spec.run(input as never, ctx);
        } catch (err) {
          // Returned (not thrown) so the model can explain the problem and try something else.
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }
  return out;
}
