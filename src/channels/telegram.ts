import { Bot, InlineKeyboard, InputFile, GrammyError } from 'grammy';
import { config } from '../config.js';
import type { Identity } from '../db/types.js';
import { log } from '../log.js';
import { formatFor, splitMessage, toPlain } from './format.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';

/**
 * One shared Telegram bot for every user. People find it by link, or by a deep link from the
 * dashboard (t.me/<bot>?start=<code>) that ties the chat to their account.
 */

let bot: Bot | undefined;
let onInbound: ((m: InboundMessage) => Promise<void>) | undefined;

export function telegramBot(): Bot | undefined {
  const cfg = config().telegram;
  if (!cfg.token || cfg.mode === 'off') return undefined;
  if (bot) return bot;
  const b = new Bot(cfg.token);

  const push = async (m: InboundMessage) => {
    if (!onInbound) throw new Error('Telegram inbound handler not registered');
    await onInbound(m);
  };

  b.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await push({
      channel: 'telegram',
      externalId: String(ctx.chat.id),
      displayName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined,
      text: '',
      command: { name: 'start', arg: ctx.match?.trim() || undefined },
      receivedAt: new Date().toISOString(),
      providerMessageId: String(ctx.msg.message_id),
    });
  });

  b.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => {});
    if (!ctx.chat) return;
    if (data.startsWith('ap:')) {
      // Remove the buttons so the same approval can't be pressed twice.
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await push({
        channel: 'telegram',
        externalId: String(ctx.chat.id),
        text: '',
        command: { name: 'approval', arg: data.slice(3) },
        receivedAt: new Date().toISOString(),
      });
    }
  });

  b.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return; // groups later
    const m = ctx.msg;
    const media: InboundMessage['media'] = [];
    if (m.voice) media.push({ kind: 'audio', mediaType: m.voice.mime_type ?? 'audio/ogg', url: `tg:${m.voice.file_id}`, filename: 'voice.ogg' });
    if (m.audio) media.push({ kind: 'audio', mediaType: m.audio.mime_type ?? 'audio/mpeg', url: `tg:${m.audio.file_id}`, filename: m.audio.file_name ?? 'audio' });
    if (m.photo?.length) media.push({ kind: 'image', mediaType: 'image/jpeg', url: `tg:${m.photo[m.photo.length - 1]!.file_id}`, filename: 'photo.jpg' });
    if (m.document) media.push({ kind: m.document.mime_type?.startsWith('image/') ? 'image' : 'file', mediaType: m.document.mime_type ?? 'application/octet-stream', url: `tg:${m.document.file_id}`, filename: m.document.file_name });
    let text = m.text ?? m.caption ?? '';
    if (m.location) text = `${text}\n[Shared location: ${m.location.latitude}, ${m.location.longitude}]`.trim();
    if (m.contact) text = `${text}\n[Shared contact: ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')} ${m.contact.phone_number}]`.trim();
    if (!text && media.length === 0) return;
    await ctx.replyWithChatAction('typing').catch(() => {});
    await push({
      channel: 'telegram',
      externalId: String(ctx.chat.id),
      displayName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined,
      text,
      media,
      receivedAt: new Date(m.date * 1000).toISOString(),
      providerMessageId: String(m.message_id),
    });
  });

  b.catch((err) => log.error({ err: String(err.error) }, 'telegram handler error'));
  bot = b;
  return b;
}

export function setTelegramInbound(handler: (m: InboundMessage) => Promise<void>): void {
  onInbound = handler;
}

export async function telegramUsername(): Promise<string | null> {
  const b = telegramBot();
  if (!b) return null;
  try {
    if (!b.isInited()) await b.init();
    return b.botInfo.username;
  } catch {
    return null;
  }
}

export const telegramAdapter: ChannelAdapter = {
  name: 'telegram',
  maxLength: 3800,
  enabled: () => Boolean(telegramBot()),

  async send(identity: Identity, msg: OutboundMessage) {
    const b = telegramBot();
    if (!b) throw new Error('Telegram is not configured');
    const chatId = identity.external_id;
    const parts = splitMessage(msg.text, 3800);
    let lastId: number | undefined;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const keyboard = isLast && msg.buttons?.length ? InlineKeyboard.from([msg.buttons.map((bt) => InlineKeyboard.text(bt.label, bt.data))]) : undefined;
      try {
        const sent = await b.api.sendMessage(chatId, formatFor('telegram', parts[i]!), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
        lastId = sent.message_id;
      } catch (err) {
        // Malformed HTML from the model: fall back to plain text rather than dropping the message.
        if (err instanceof GrammyError && err.description.includes("can't parse entities")) {
          const sent = await b.api.sendMessage(chatId, toPlain(parts[i]!), keyboard ? { reply_markup: keyboard } : {});
          lastId = sent.message_id;
        } else throw err;
      }
    }
    if (msg.audio) await b.api.sendVoice(chatId, new InputFile(msg.audio, 'reply.ogg')).catch((err) => log.warn({ err: String(err) }, 'voice reply failed'));
    return { providerMessageId: lastId ? String(lastId) : undefined };
  },

  async download(media: { url: string }) {
    const b = telegramBot();
    if (!b) throw new Error('Telegram is not configured');
    const fileId = media.url.replace(/^tg:/, '');
    const file = await b.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram file has no path');
    const res = await fetch(`https://api.telegram.org/file/bot${config().telegram.token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Telegram download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

export async function telegramTyping(chatId: string): Promise<void> {
  await telegramBot()?.api.sendChatAction(chatId, 'typing').catch(() => {});
}
