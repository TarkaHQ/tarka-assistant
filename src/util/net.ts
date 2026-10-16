import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Guards outbound fetches made on the model's behalf (web_read): only http(s) on the usual ports,
 * no credentials in the URL, and never a private, loopback, link-local, metadata or otherwise
 * special address. The connection is pinned to addresses that passed the check, so DNS can't
 * swap in an internal address between the check and the connect (rebinding), and every
 * redirect is checked again.
 */

const v4Blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) v4Blocked.addSubnet(net, prefix, 'ipv4');

const v6Blocked = new BlockList();
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible (embedded IPv4 is checked separately too)
  ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) v6Blocked.addSubnet(net, prefix, 'ipv6');

/** The eight 16-bit groups of an IPv6 address (handles "::" and a trailing dotted IPv4). */
export function v6Groups(addr: string): number[] | null {
  let s = addr.toLowerCase();
  let v4: number[] = [];
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const o = dotted.slice(2, 6).map(Number);
    if (o.some((x) => x > 255)) return null;
    v4 = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    s = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : Number.NaN)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fixed = head.length + tail.length + v4.length;
  const zeros = halves.length === 2 ? 8 - fixed : 0;
  if (zeros < 0 || (halves.length === 1 && fixed !== 8)) return null;
  const groups = [...head, ...new Array<number>(zeros).fill(0), ...tail, ...v4];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** IPv4 carried inside an IPv6 address: mapped, compatible, NAT64 (64:ff9b::/96) or 6to4. */
function embeddedV4(g: number[]): string | null {
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return quad(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return quad(g[6]!, g[7]!);
  if (g[0] === 0x2002) return quad(g[1]!, g[2]!);
  return null;
}

export function isPrivate(addr: string): boolean {
  const clean = addr.replace(/^\[|\]$/g, '').split('%')[0]!;
  const kind = isIP(clean);
  if (kind === 4) return v4Blocked.check(clean, 'ipv4');
  if (kind === 6) {
    const g = v6Groups(clean);
    if (!g) return true;
    const v4 = embeddedV4(g);
    if (v4 && v4Blocked.check(v4, 'ipv4')) return true;
    return v6Blocked.check(clean, 'ipv6');
  }
  return true; // not an IP at all: refuse rather than guess
}

const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata|metadata\.google\.internal|tarka)$/i;

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links can be opened');
  if (url.username || url.password) throw new Error('Links with credentials are not allowed');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new Error('That port is not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.test(host)) throw new Error('That address is not reachable');
  return url;
}

type Resolved = { address: string; family: 4 | 6 };

/** Resolves a host to public addresses only. */
async function publicAddresses(host: string): Promise<Resolved[]> {
  const literal = isIP(host);
  const found: Resolved[] = literal ? [{ address: host, family: literal as 4 | 6 }] : ((await lookup(host, { all: true, verbatim: true })) as Resolved[]);
  if (found.length === 0) throw new Error('That address could not be found');
  for (const a of found) if (isPrivate(a.address)) throw new Error('That address is not reachable');
  return found;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = checkUrl(raw);
  await publicAddresses(url.hostname.replace(/^\[|\]$/g, ''));
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Resolved[], family?: number) => void;

/** The socket's own DNS lookup, re-checked: whatever it connects to has passed isPrivate. */
export function pinnedLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  publicAddresses(hostname.replace(/^\[|\]$/g, ''))
    .then((addrs) => {
      if (typeof options === 'object' && options !== null && (options as { all?: boolean }).all) callback(null, addrs);
      else callback(null, addrs[0]!.address, addrs[0]!.family);
    })
    .catch((err: Error) => callback(Object.assign(err, { code: 'EBLOCKED' }) as NodeJS.ErrnoException, ''));
}

const pinnedAgent = new Agent({
  connect: { lookup: pinnedLookup as never, timeout: 10_000 },
  headersTimeout: 20_000,
  bodyTimeout: 20_000,
});

/** fetch() that follows at most 5 redirects, re-validating each hop, with a size cap. */
export async function safeFetch(
  raw: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  maxBytes = 3_000_000,
): Promise<{ url: string; status: number; contentType: string; body: string }> {
  let current = (await assertPublicUrl(raw)).toString();
  for (let hop = 0; hop < 6; hop++) {
    const res = await undiciFetch(current, {
      headers: init.headers,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(20_000),
      dispatcher: pinnedAgent,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
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
