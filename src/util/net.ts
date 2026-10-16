import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Guards outbound fetches made on the model's behalf (web_read): only http(s), no credentials in
 * the URL, and no private, loopback, link-local or metadata addresses. Re-checked on redirects.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links can be opened');
  if (url.username || url.password) throw new Error('Links with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new Error('That address is not reachable');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const addr of addresses) if (isPrivate(addr)) throw new Error('That address is not reachable');
  return url;
}

export function isPrivate(addr: string): boolean {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number) as [number, number, number, number];
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = addr.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivate(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** fetch() that follows at most 5 redirects, re-validating each hop, with a size cap. */
export async function safeFetch(raw: string, init: RequestInit = {}, maxBytes = 3_000_000): Promise<{ url: string; status: number; contentType: string; body: string }> {
  let current = (await assertPublicUrl(raw)).toString();
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = (await assertPublicUrl(new URL(res.headers.get('location')!, current).toString())).toString();
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const body = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
    return { url: current, status: res.status, contentType: res.headers.get('content-type') ?? '', body };
  }
  throw new Error('Too many redirects');
}
