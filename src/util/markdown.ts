/**
 * Minimal, safe Markdown → HTML for chat messages: escapes everything, then allows paragraphs,
 * line breaks, **bold**, *italic*, `code`, fenced code, [links](https://…), bare URLs and lists.
 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(s: string): string {
  const links: string[] = [];
  let out = esc(s);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,!?:;'"])/g, (_m, pre: string, url: string) => {
    links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url.length > 60 ? `${url.slice(0, 57)}…` : url}</a>`);
    return `${pre}\u0001${links.length - 1}\u0001`;
  });
  out = out
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_(\S[^_]*?)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  return out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)] ?? '');
}

export function renderMarkdown(md: string): string {
  const blocks: string[] = [];
  const text = md.replace(/\r/g, '');
  const fenced = text.split(/```/);
  fenced.forEach((chunk, idx) => {
    if (idx % 2 === 1) {
      blocks.push(`<pre><code>${esc(chunk.replace(/^[a-z]*\n/, ''))}</code></pre>`);
      return;
    }
    for (const para of chunk.split(/\n{2,}/)) {
      const lines = para.split('\n').filter((l) => l.trim() !== '');
      if (lines.length === 0) continue;
      if (lines.every((l) => /^\s*([-*+•]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\s*\d+[.)]/.test(lines[0]!);
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*([-*+•]|\d+[.)])\s+/, ''))}</li>`).join('');
        blocks.push(ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`);
      } else if (/^#{1,6}\s/.test(lines[0]!)) {
        blocks.push(`<p><strong>${inline(lines[0]!.replace(/^#{1,6}\s+/, ''))}</strong>${lines.length > 1 ? `<br>${lines.slice(1).map(inline).join('<br>')}` : ''}</p>`);
      } else {
        blocks.push(`<p>${lines.map(inline).join('<br>')}</p>`);
      }
    }
  });
  return blocks.join('');
}
