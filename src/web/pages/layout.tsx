import type { Child, FC } from 'hono/jsx';
import { config } from '../../config.js';
import type { User } from '../../db/types.js';

export const Logo: FC<{ href?: string }> = ({ href = '/' }) => (
  <a class="brand" href={href} aria-label={`${config().product.productName} home`}>
    {/* Same geometry as frontend/src/components/ui/TarkaLogo.astro */}
    <svg viewBox="0 0 128 88" fill="currentColor" aria-hidden="true">
      <polygon points="0,88 43,14 86,88" />
      <polygon points="56,88 92,26 128,88" />
    </svg>
    <span class="brand-name">TARKA</span>
    <span class="brand-product">Assistant</span>
  </a>
);

/** The ridge motif from business/marketing/brand/assets/tarka-motif.svg, repeated along the top edge. */
export const Ridge: FC = () => {
  const peaks: [number, number, number, string][] = [
    [18, 48, 78, '#14181f'], [72, 96, 120, '#fb5b34'], [137, 171, 205, '#e0e7ef'], [206, 231, 256, '#59dbe1'],
    [276, 309, 342, '#ecf0f4'], [360, 382, 404, '#f2d533'], [426, 458, 490, '#6a829e'], [504, 529, 554, '#7ea685'],
    [575, 607, 639, '#f5f7fa'], [646, 672, 698, '#fb5b34'], [720, 753, 786, '#e0e7ef'], [800, 823, 846, '#59dbe1'],
    [868, 900, 932, '#14181f'], [948, 973, 998, '#efe7a8'], [1018, 1050, 1082, '#6a829e'],
  ];
  const tops = [54, 64, 47, 62, 49, 68, 51, 63, 50, 61, 48, 66, 51, 63, 50];
  return (
    <div class="ridge" aria-hidden="true">
      <svg viewBox="0 30 2240 80" preserveAspectRatio="xMinYMax slice">
        {[0, 1120].map((dx) =>
          peaks.map(([a, b, c, fill], i) => <polygon points={`${a + dx},106 ${b + dx},${tops[i]} ${c + dx},106`} fill={fill} />),
        )}
      </svg>
    </div>
  );
};

const NAV: [string, string][] = [
  ['/app', 'Chat'],
  ['/app/memory', 'Memory'],
  ['/app/schedule', 'Schedule'],
  ['/app/activity', 'Activity'],
  ['/app/hood', 'Under the hood'],
  ['/app/settings', 'Settings'],
];

export const Layout: FC<{ title: string; user?: User | null; active?: string; children?: Child; scripts?: boolean; ridge?: boolean }> = ({ title, user, active, children, scripts, ridge }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Manrope:wght@400;500;600;700&family=Sora:wght@800&family=Space+Grotesk:wght@500;700&display=swap"
      />
      <link rel="stylesheet" href="/static/app.css" />
      <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 88'%3E%3Cpolygon points='0,88 43,14 86,88' fill='%2314181f'/%3E%3Cpolygon points='56,88 92,26 128,88' fill='%23fb5b34'/%3E%3C/svg%3E" />
    </head>
    <body>
      {ridge ? <Ridge /> : null}
      {user ? (
        <header class="topbar">
          <div class="shell">
            <Logo href="/app" />
            <nav class="nav" aria-label="Main">
              {NAV.map(([href, label]) => (
                <a href={href} aria-current={active === href ? 'page' : undefined}>
                  {label}
                </a>
              ))}
            </nav>
            <form method="post" action="/logout">
              <button class="link-button" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </header>
      ) : null}
      {children}
      {scripts ? <script src="/static/app.js" defer></script> : null}
    </body>
  </html>
);
