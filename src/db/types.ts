export type ChannelName = 'web' | 'telegram' | 'sms' | 'whatsapp' | 'voice' | 'email' | 'cli';

export interface UserSettings {
  /** Local times "HH:MM". Agent-initiated messages wait until quiet hours end. */
  quietHours?: { start: string; end: string };
  /** "HH:MM" local time for the morning brief, or null when switched off. */
  briefTime?: string | null;
  proactivity?: 'off' | 'low' | 'normal' | 'high';
  preferredChannel?: ChannelName;
  meetingNudges?: boolean;
  voiceReplies?: boolean;
  /** Free-form notes the user gave about how they want to be helped. */
  helpWith?: string;
  /** Keyed hash of the voice PIN (never the PIN itself). */
  voicePin?: { hash: string; length: number } | null;
  /** Ask for the PIN even when the carrier vouches for the caller's number. */
  voiceRequirePin?: boolean;
}

export interface User {
  id: string;
  created_at: Date;
  updated_at: Date;
  status: 'onboarding' | 'active' | 'paused' | 'deleted';
  name: string | null;
  email: string | null;
  phone: string | null;
  timezone: string;
  locale: string;
  city: string | null;
  assistant_name: string | null;
  plan: 'trial' | 'pro' | 'free' | 'staff';
  trial_ends_at: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  model: string | null;
  settings: UserSettings;
  profile_summary: string | null;
  profile_refreshed_at: Date | null;
  memory_bank: string | null;
  last_active_at: Date | null;
  last_channel: ChannelName | null;
}

export interface Identity {
  id: string;
  user_id: string;
  channel: ChannelName;
  external_id: string;
  display: string | null;
  verified_at: Date | null;
  last_inbound_at: Date | null;
  opted_out_at: Date | null;
  created_at: Date;
}

export interface MessageRow {
  id: number;
  user_id: string;
  created_at: Date;
  role: 'user' | 'assistant' | 'event';
  channel: ChannelName;
  content: string;
  meta: Record<string, unknown>;
}

export type RoutineKind = 'reminder' | 'task' | 'brief' | 'checkin' | 'followup' | 'watch';

export interface Routine {
  id: string;
  user_id: string;
  kind: RoutineKind;
  title: string;
  instructions: string | null;
  schedule_type: 'once' | 'cron';
  run_at: Date | null;
  cron: string | null;
  timezone: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  status: 'active' | 'paused' | 'done' | 'cancelled';
  created_by: 'user' | 'agent' | 'system';
  channel: ChannelName | null;
  meta: Record<string, unknown>;
  run_count: number;
  created_at: Date;
}

export interface Approval {
  id: string;
  user_id: string;
  short_code: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'failed';
  channel: ChannelName | null;
  /** 'message' when the person asked for it; otherwise the unprompted trigger (routine, brief…). */
  origin: string;
  result: unknown;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
}

export interface Integration {
  id: string;
  user_id: string;
  provider: 'google';
  account: string | null;
  scopes: string[];
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface CallRow {
  id: string;
  user_id: string;
  direction: 'inbound' | 'outbound';
  to_number: string | null;
  from_number: string | null;
  objective: string | null;
  status: string;
  provider_call_id: string | null;
  transcript: string | null;
  summary: string | null;
  created_at: Date;
  ended_at: Date | null;
  meta: Record<string, unknown>;
}

export interface UsageRow {
  model: string;
  purpose: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  calls: number;
}
