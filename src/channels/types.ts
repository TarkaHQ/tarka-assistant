import type { ChannelName, Identity } from '../db/types.js';

export interface InboundMedia {
  kind: 'image' | 'audio' | 'file';
  mediaType: string;
  filename?: string;
  /** Either raw bytes or a URL the adapter can download with its own credentials. */
  data?: Uint8Array;
  url?: string;
}

export interface InboundMessage {
  channel: ChannelName;
  /** Sender address on that channel: E.164 number, Telegram chat id, email address. */
  externalId: string;
  displayName?: string;
  text: string;
  media?: InboundMedia[];
  providerMessageId?: string;
  receivedAt: string; // ISO; jobs are JSON
  /** When our webhook took it (our clock). Orders it against what the assistant had sent by then. */
  queuedAt?: string;
  /** Telegram /start payload, approval button presses, etc. */
  command?: { name: string; arg?: string };
  /** ISO 3166 alpha-2 of the sender's number, when known (WhatsApp gating). */
  country?: string;
}

export interface OutboundButton {
  label: string;
  data: string;
}

export interface OutboundMessage {
  text: string;
  buttons?: OutboundButton[];
  /** Spoken version for channels that support voice notes. */
  audio?: Uint8Array;
  /** Marks agent-initiated messages (morning brief, nudges) for templates and accounting. */
  proactive?: boolean;
}

export interface ChannelAdapter {
  name: ChannelName;
  enabled(): boolean;
  /** Characters per message part before splitting. */
  maxLength: number;
  send(identity: Identity, msg: OutboundMessage): Promise<{ providerMessageId?: string } | void>;
  /** Download media referenced by URL with the channel's own credentials. */
  download?(media: { url: string }): Promise<Uint8Array>;
}
