import type { ChannelName, Identity } from '../db/types.js';
import { smsAdapter, whatsappAdapter } from './telnyx.js';
import { telegramAdapter } from './telegram.js';
import type { ChannelAdapter } from './types.js';

/** Web chat has no push transport: messages are stored and the dashboard shows them. */
const webAdapter: ChannelAdapter = {
  name: 'web',
  maxLength: 20_000,
  enabled: () => true,
  async send(_identity: Identity) {
    return {};
  },
};

const adapters: Partial<Record<ChannelName, ChannelAdapter>> = {
  web: webAdapter,
  telegram: telegramAdapter,
  sms: smsAdapter,
  whatsapp: whatsappAdapter,
};

export function adapterFor(channel: ChannelName): ChannelAdapter | undefined {
  return adapters[channel];
}

export function messagingChannels(): ChannelName[] {
  return (Object.keys(adapters) as ChannelName[]).filter((c) => adapters[c]!.enabled());
}
