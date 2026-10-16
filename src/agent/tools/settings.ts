import { z } from 'zod';
import { config } from '../../config.js';
import { integrations, messages, users } from '../../db/repo.js';
import { sendToUser } from '../../channels/deliver.js';
import type { UserSettings } from '../../db/types.js';
import { memory } from '../../memory/hindsight.js';
import { syncSystemRoutines } from '../../proactive/system-routines.js';
import { isValidHHMM, isValidTimezone } from '../../util/time.js';
import { connectGoogleLink, dashboardLink, upgradeLink } from '../../web/links.js';
import { defineTool, type ToolSpec } from './spec.js';

const hhmm = z.string().refine(isValidHHMM, 'Use 24-hour HH:MM');

export const settingsTools: ToolSpec[] = [
  defineTool({
    name: 'update_profile',
    label: 'Updating your settings',
    description:
      'Save the user’s details and preferences: their name, IANA timezone (e.g. "Europe/Berlin", infer it from their city), city, what they call you, morning brief time (HH:MM, or "off"), quiet hours, how proactive to be, preferred channel, meeting nudges, voice replies. Only pass fields the user gave or clearly implied.',
    input: z.object({
      name: z.string().min(1).max(80).optional(),
      timezone: z.string().optional().describe('IANA zone, e.g. America/New_York'),
      city: z.string().max(120).optional(),
      assistant_name: z.string().min(1).max(40).optional(),
      brief_time: z.union([hhmm, z.literal('off')]).optional(),
      quiet_hours: z.object({ start: hhmm, end: hhmm }).optional(),
      proactivity: z.enum(['off', 'low', 'normal', 'high']).optional(),
      preferred_channel: z.enum(['web', 'telegram', 'sms', 'whatsapp']).optional(),
      meeting_nudges: z.boolean().optional(),
      voice_replies: z.boolean().optional(),
      help_with: z.string().max(500).optional().describe('What the user mainly wants help with, in their words'),
    }),
    run: async (input, ctx) => {
      if (input.timezone && !isValidTimezone(input.timezone)) throw new Error(`"${input.timezone}" is not a valid IANA timezone`);
      const user = await users.update(ctx.user.id, {
        name: input.name,
        timezone: input.timezone,
        city: input.city,
        assistant_name: input.assistant_name,
      });
      const settings: Partial<UserSettings> = {};
      if (input.brief_time !== undefined) settings.briefTime = input.brief_time === 'off' ? null : input.brief_time;
      if (input.quiet_hours) settings.quietHours = input.quiet_hours;
      if (input.proactivity) settings.proactivity = input.proactivity;
      if (input.preferred_channel) settings.preferredChannel = input.preferred_channel;
      if (input.meeting_nudges !== undefined) settings.meetingNudges = input.meeting_nudges;
      if (input.voice_replies !== undefined) settings.voiceReplies = input.voice_replies;
      if (input.help_with) settings.helpWith = input.help_with;
      const updated = Object.keys(settings).length ? await users.updateSettings(ctx.user.id, settings) : user;
      Object.assign(ctx.user, updated);
      if (input.timezone || input.brief_time !== undefined || input.proactivity) await syncSystemRoutines(updated);
      if (input.name) memory.remember(updated, `The user's name is ${input.name}.`).catch(() => {});
      ctx.activity.push({ tool: 'update_profile', summary: 'Updated settings' });
      return {
        saved: true,
        profile: {
          name: updated.name, timezone: updated.timezone, city: updated.city, assistant_name: updated.assistant_name,
          brief_time: updated.settings.briefTime === undefined ? '07:30' : updated.settings.briefTime ?? 'off',
          proactivity: updated.settings.proactivity ?? 'normal',
        },
      };
    },
  }),

  defineTool({
    name: 'finish_onboarding',
    label: 'Finishing setup',
    description: 'Call once the user’s name and timezone are known during onboarding. Starts their morning brief and normal operation.',
    input: z.object({}),
    available: (ctx) => ctx.user.status === 'onboarding',
    run: async (_i, ctx) => {
      if (!ctx.user.name || ctx.user.timezone === 'UTC') {
        // UTC is allowed, but only when the user actually said so.
        if (!ctx.user.name) throw new Error('Ask for the user’s name first');
      }
      const updated = await users.update(ctx.user.id, { status: 'active' });
      Object.assign(ctx.user, updated);
      await syncSystemRoutines(updated);
      ctx.activity.push({ tool: 'finish_onboarding', summary: 'Setup complete' });
      return { status: 'active', brief_time: updated.settings.briefTime ?? '07:30' };
    },
  }),

  // Sign-in links are sent to the person by code, as their own message. The model never sees them
  // (a page or email it reads can't talk it into passing one on), and they never enter the
  // conversation history.
  defineTool({
    name: 'dashboard_link',
    label: 'Sending a sign-in link',
    description: 'Send the user a one-time link (valid 30 minutes) that signs them into their web dashboard: memory, reminders, activity, usage, settings. It arrives as a separate message.',
    input: z.object({}),
    available: (ctx) => ctx.trigger === 'message',
    run: async (_i, ctx) => {
      if (ctx.channel === 'web' || ctx.channel === 'cli') return { already_signed_in: true, note: 'They are using the web dashboard right now; point them to the tabs at the top.' };
      const url = await dashboardLink(ctx.user);
      await sendToUser(ctx.user, `Here’s your dashboard (the link works once, for 30 minutes):\n${url}`, { channel: ctx.channel });
      await messages.add(ctx.user.id, 'event', ctx.channel, 'Sent the user a one-time sign-in link to the dashboard.');
      return { sent: true, note: 'The link was sent as its own message just now. Do not write a URL yourself.' };
    },
  }),

  defineTool({
    name: 'connect_google_link',
    label: 'Sending a Google link',
    description: 'Send the user a link to connect their Google account (Gmail, Calendar, Drive, Contacts) so you can read their calendar and email and draft or send on their behalf. It arrives as a separate message; they confirm with a code sent here.',
    input: z.object({}),
    available: (ctx) => config().google.enabled && ctx.trigger === 'message',
    run: async (_i, ctx) => {
      const existing = await integrations.get(ctx.user.id, 'google');
      if (existing?.status === 'active') return { already_connected: existing.account };
      if (ctx.channel === 'web' || ctx.channel === 'cli') return { sent: false, note: 'They are on the web dashboard: they can connect Google under Settings.' };
      const url = await connectGoogleLink(ctx.user);
      await sendToUser(ctx.user, `Connect your Google account here (the link works once, for 30 minutes):\n${url}`, { channel: ctx.channel });
      await messages.add(ctx.user.id, 'event', ctx.channel, 'Sent the user a link to connect Google.');
      return { sent: true, note: 'The link was sent as its own message just now. Do not write a URL yourself.' };
    },
  }),

  defineTool({
    name: 'upgrade_link',
    label: 'Making a checkout link',
    description: `Create a checkout link for the paid plan (${config().product.priceLabel}). Offer it when the trial is ending or the user asks about paying.`,
    input: z.object({}),
    available: () => config().stripe.enabled,
    run: async (_i, ctx) => ({ url: upgradeLink(ctx.user), price: config().product.priceLabel }),
  }),
];
