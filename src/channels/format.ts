import type { ChannelName } from '../db/types.js';

/** Removes reasoning tags some models leak into content. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<\/?think>\s*/gi, '').trim();
}

/** End-of-turn markers some servers leave on an otherwise good reply. */
const TRAILING_END_TOKENS = /(\s*(<\|(?:im_end|eot_id|eom_id|end|endoftext|end_of_text)\|>|<｜end▁of▁sentence｜>|<\/s>))+\s*$/;

/**
 * Chat-template control tokens that leaked into a reply: the serving side failed to turn the
 * model's output into a tool call or a message (Kimi K3 on Tarka sent `<|open|>tools<|sep|>…` as
 * text). Also the raw tool-call shapes of a few other model families. Such a reply must never
 * reach the user.
 */
const LEAKED_TOKENS =
  /<\|[A-Za-z0-9_▁]{2,32}\|>|<｜[^｜\n]{1,40}｜>|<\/?tool_call>|\[TOOL_CALLS\]|<minimax:tool_call>|(^|\n)\s*functions\.[A-Za-z0-9_]+:\d+\s*\{/;

export function hasLeakedTokens(text: string): boolean {
  return LEAKED_TOKENS.test(text.replace(TRAILING_END_TOKENS, ''));
}

/** The model's reply as it may be shown: thinking and stray end markers removed, nothing if garbled. */
export function usableReply(text: string): string {
  const t = stripThinking(text).replace(TRAILING_END_TOKENS, '').trim();
  return hasLeakedTokens(t) ? '' : t;
}

/** Markdown → plain text for SMS and voice. Keeps link URLs visible. */
export function toPlain(md: string): string {
  return md
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 $2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S[^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Markdown subset → Telegram HTML (bold, italic, code, links, bullets). */
export function toTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  let s = md.replace(/```[a-z]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });
  s = escapeHtml(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_(\S[^_\n]*?)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/^\s*[-*+]\s+/gm, '• ');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? '');
}

/** Splits on paragraph, then sentence boundaries to stay under `max` characters per part. */
export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = '';
  };
  for (const para of text.split(/\n{2,}/)) {
    if ((current + '\n\n' + para).length <= max) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    push();
    if (para.length <= max) {
      current = para;
      continue;
    }
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      if ((current + ' ' + sentence).length > max) push();
      if (sentence.length > max) {
        for (let i = 0; i < sentence.length; i += max) parts.push(sentence.slice(i, i + max));
      } else current = current ? `${current} ${sentence}` : sentence;
    }
  }
  push();
  return parts;
}

export function formatFor(channel: ChannelName, md: string): string {
  const clean = stripThinking(md);
  switch (channel) {
    case 'sms':
    case 'voice':
    case 'whatsapp':
      return channel === 'whatsapp' ? toWhatsApp(clean) : toPlain(clean);
    case 'telegram':
      return toTelegramHtml(clean);
    default:
      return clean;
  }
}

/** WhatsApp understands *bold* and _italic_ natively. */
export function toWhatsApp(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label}: ${url}`))
    .replace(/^\s*[-+]\s+/gm, '• ')
    .trim();
}
