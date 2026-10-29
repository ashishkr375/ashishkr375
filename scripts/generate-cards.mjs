#!/usr/bin/env node
/**
 * Self-hosted GitHub profile cards.
 *
 * Pulls live data from the GitHub GraphQL API and writes animated SVG cards
 * (stats, languages, streak, trophies, activity graph, pinned repos).
 * Runs inside GitHub Actions, so it never depends on a third-party
 * Vercel instance being up or rate-limited.
 *
 *   GH_TOKEN=xxx node scripts/generate-cards.mjs --out dist
 *   node scripts/generate-cards.mjs --mock --out preview   # offline preview
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ─────────────────────────────── config ─────────────────────────────── */

export const CONFIG = {
  login: process.env.GH_LOGIN || 'ashishkr375',
  // Repos rendered as cards under "Featured Repositories" (owner defaults to login).
  featured: [
    'nitp-main-website-ec2',
    'Faculty-Performance-Appraisal-Performa-',
    'fns',
    'SecureCartel-Extension1',
  ],
  // Languages that are markup / noise rather than code you wrote.
  ignoreLanguages: ['HTML', 'CSS', 'SCSS', 'Jupyter Notebook', 'Procfile', 'Dockerfile', 'Makefile'],
};

const C = {
  bg: '#0d1117',
  panel: '#0f1724',
  tile: '#111c2e',
  border: '#1e293b',
  text: '#e2e8f0',
  muted: '#94a3b8',
  dim: '#64748b',
  accent: '#38bdf8',
  accent2: '#a78bfa',
  amber: '#f59e0b',
  green: '#22c55e',
};
const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
const MONO = `'JetBrains Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;
const FALLBACK_LANG_COLORS = ['#38bdf8', '#a78bfa', '#f59e0b', '#22c55e', '#f472b6', '#fb7185', '#2dd4bf', '#facc15'];

/* ─────────────────────────────── helpers ─────────────────────────────── */

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const kfmt = (n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`;
  return n.toLocaleString('en-US');
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parseDay = (d) => new Date(`${d}T00:00:00Z`);
const dShort = (d) => { const x = parseDay(d); return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}`; };
const dLong = (d) => { const x = parseDay(d); return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}, ${x.getUTCFullYear()}`; };
const range = (a, b) => {
  if (!a) return '—';
  if (a === b) return dLong(a);
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return sameYear ? `${dShort(a)} – ${dShort(b)}, ${b.slice(0, 4)}` : `${dLong(a)} – ${dLong(b)}`;
};

/** Rough text width for truncation/wrapping (sans-serif). */
const textW = (s, size, bold = false) => [...s].length * size * (bold ? 0.6 : 0.56);

function truncate(s, size, maxW, bold = false) {
  if (textW(s, size, bold) <= maxW) return s;
  let out = s;
  while (out.length > 1 && textW(`${out}…`, size, bold) > maxW) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function wrap(s, size, maxW, maxLines) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textW(next, size) <= maxW) cur = next;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = truncate(`${kept[maxLines - 1]} ${lines[maxLines]}`, size, maxW);
    return kept;
  }
  return lines;
}

/* ─────────────────────────────── icons (16×16) ─────────────────────────────── */

const ICON = {
  pulse: `<path d="M1 8h3l2-5 4 10 2-5h3" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  commit: `<circle cx="8" cy="8" r="3" fill="none" stroke-width="1.6"/><path d="M1 8h4M11 8h4" stroke-width="1.6" stroke-linecap="round"/>`,
  pr: `<circle cx="4" cy="3.5" r="1.9" fill="none" stroke-width="1.5"/><circle cx="4" cy="12.5" r="1.9" fill="none" stroke-width="1.5"/><circle cx="12" cy="12.5" r="1.9" fill="none" stroke-width="1.5"/><path d="M4 5.5v5M12 10.5V6.5a2 2 0 0 0-2-2H7.5m0 0 1.8-1.8M7.5 4.5l1.8 1.8" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  issue: `<circle cx="8" cy="8" r="6" fill="none" stroke-width="1.6"/><circle cx="8" cy="8" r="1.6" stroke="none"/>`,
  star: `<path d="M8 1.3l2 4.2 4.6.6-3.4 3.2.9 4.6L8 11.6l-4.1 2.3.9-4.6L1.4 6.1 6 5.5z" fill="none" stroke-width="1.4" stroke-linejoin="round"/>`,
  starSolid: `<path d="M8 1.3l2 4.2 4.6.6-3.4 3.2.9 4.6L8 11.6l-4.1 2.3.9-4.6L1.4 6.1 6 5.5z" stroke="none"/>`,
  repo: `<path d="M3 2.5A1.5 1.5 0 0 1 4.5 1H13v11H4.5A1.5 1.5 0 0 0 3 13.5v-11zM3 13.5A1.5 1.5 0 0 0 4.5 15H13v-3" fill="none" stroke-width="1.5" stroke-linejoin="round"/>`,
  fork: `<circle cx="4" cy="3" r="1.8" fill="none" stroke-width="1.5"/><circle cx="12" cy="3" r="1.8" fill="none" stroke-width="1.5"/><circle cx="8" cy="13" r="1.8" fill="none" stroke-width="1.5"/><path d="M4 4.8v1.2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4.8M8 8v3.2" fill="none" stroke-width="1.5"/>`,
  code: `<path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  trophy: `<path d="M4.5 1.5h7v4.2a3.5 3.5 0 0 1-7 0V1.5zM4.5 3H2v1.2A2.3 2.3 0 0 0 4.6 6.5M11.5 3H14v1.2a2.3 2.3 0 0 1-2.6 2.3M8 9.2v2.8M5 14.5h6M6 12h4v2.5H6z" fill="none" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`,
  flame: `<path d="M8 1c.5 2.6 3.6 4 3.6 7.6A3.6 3.6 0 0 1 8 12.2a3.6 3.6 0 0 1-3.6-3.6c0-1.6.8-2.7 1.7-3.6.2 1.2.8 2 1.6 2.3C7.3 5.5 7.2 3 8 1z" stroke="none"/>`,
};

const icon = (name, x, y, color, size = 16) =>
  `<g transform="translate(${x} ${y}) scale(${size / 16})" stroke="${color}" fill="${color}">${ICON[name]}</g>`;

/* ─────────────────────────────── card frame ─────────────────────────────── */

function frame({ w, h, title, sub, body, extraStyle = '', label }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label || title || 'card')}">
<style>
  .t{font:600 16px ${SANS};fill:${C.text}}
  .s{font:400 12px ${MONO};fill:${C.dim}}
  .lbl{font:400 13px ${SANS};fill:${C.muted}}
  .val{font:700 14px ${SANS};fill:${C.text}}
  .f{animation:fi .7s cubic-bezier(.2,.8,.2,1) both}
  @keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  ${extraStyle}
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<defs>
  <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.accent}"/><stop offset="1" stop-color="${C.accent2}"/></linearGradient>
</defs>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="12" fill="${C.panel}" stroke="${C.border}"/>
${title ? `<text class="t f" x="24" y="36">${esc(title)}</text>` : ''}
${sub ? `<text class="s f" x="${w - 24}" y="36" text-anchor="end">${esc(sub)}</text>` : ''}
${body}
</svg>
`;
}

const delay = (i, base = 0.1, step = 0.08) => `style="animation-delay:${(base + i * step).toFixed(2)}s"`;

/* ─────────────────────────────── cards ─────────────────────────────── */

export function statsCard(d) {
  const rows = [
    ['pulse', 'Total contributions', kfmt(d.totalContributions)],
    ['commit', 'Commits', kfmt(d.totalCommits)],
    ['pr', 'Pull requests', kfmt(d.pullRequests)],
    ['issue', 'Issues opened', kfmt(d.issues)],
    ['star', 'Stars earned', kfmt(d.stars)],
    ['repo', 'Repositories', kfmt(d.repos)],
  ];
  const rowsSvg = rows
    .map(([ic, label, val], i) => {
      const y = 68 + i * 22;
      return `<g class="f" ${delay(i, 0.15)}>${icon(ic, 24, y - 12, C.accent, 14)}<text class="lbl" x="46" y="${y}">${label}</text><text class="val" x="232" y="${y}" text-anchor="end">${val}</text></g>`;
    })
    .join('\n');

  const pct = Math.max(2, Math.min(100, Math.round((d.activeDaysYear / 365) * 100)));
  const cx = 318, cy = 112, r = 44;
  const ring = `
  <g class="f" ${delay(0, 0.2)}>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.border}" stroke-width="8"/>
    <circle class="ring" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#acc)" stroke-width="8" stroke-linecap="round"
      pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy + 2}" text-anchor="middle" style="font:700 22px ${SANS};fill:${C.text}">${kfmt(d.yearContributions)}</text>
    <text x="${cx}" y="${cy + 19}" text-anchor="middle" style="font:400 10.5px ${SANS};fill:${C.muted}">past year</text>
    <text x="${cx}" y="${cy + 72}" text-anchor="middle" style="font:500 11px ${SANS};fill:${C.dim}">${d.activeDaysYear} active days</text>
  </g>`;
  return frame({
    w: 400, h: 200, title: 'GitHub Stats', sub: `@${d.login}`, label: `${d.login} GitHub stats`,
    extraStyle: `.ring{animation:ring 1.6s cubic-bezier(.2,.8,.2,1) .3s both}@keyframes ring{from{stroke-dasharray:0 100}}`,
    body: rowsSvg + ring,
  });
}

export function languagesCard(d) {
  const langs = d.languages.slice(0, 8);
  const barX = 24, barY = 54, barW = 352, barH = 10;
  let x = barX;
  const segs = langs
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const s = `<rect x="${x.toFixed(2)}" y="${barY}" width="${Math.max(w, 0.5).toFixed(2)}" height="${barH}" fill="${l.color}"/>`;
      x += w;
      return s;
    })
    .join('');
  const legend = langs
    .map((l, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const lx = 24 + col * 188, ly = 96 + row * 26;
      return `<g class="f" ${delay(i, 0.35, 0.06)}><circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${l.color}"/><text x="${lx + 18}" y="${ly}" style="font:500 13px ${SANS};fill:${C.text}">${esc(truncate(l.name, 13, 110))}</text><text x="${lx + 164}" y="${ly}" text-anchor="end" style="font:400 12px ${MONO};fill:${C.muted}">${l.pct.toFixed(1)}%</text></g>`;
    })
    .join('\n');
  const body = langs.length
    ? `<defs><clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5"><animate attributeName="width" from="0" to="${barW}" dur="1.3s" begin="0.2s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"/></rect></clipPath></defs>
  <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="${C.border}"/>
  <g clip-path="url(#bar)">${segs}</g>
  ${legend}`
    : `<text x="200" y="120" text-anchor="middle" class="lbl">No language data yet</text>`;
  return frame({ w: 400, h: 200, title: 'Most Used Languages', sub: 'by code size', body, label: 'Most used languages' });
}

export function streakCard(d) {
  const col = (cx, i, big, bigColor, label, labelColor, sub) => `
  <g class="f" ${delay(i, 0.15, 0.12)}>
    <text x="${cx}" y="98" text-anchor="middle" style="font:700 28px ${SANS};fill:${bigColor}">${big}</text>
    <text x="${cx}" y="146" text-anchor="middle" style="font:600 13px ${SANS};fill:${labelColor}">${label}</text>
    <text x="${cx}" y="166" text-anchor="middle" style="font:400 10.5px ${SANS};fill:${C.dim}">${esc(sub)}</text>
  </g>`;
  const cx = 200, cy = 86, r = 38;
  const mid = `
  <g class="f" ${delay(1, 0.15, 0.12)}>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.border}" stroke-width="6"/>
    <circle class="ring" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.amber}" stroke-width="6" stroke-linecap="round" pathLength="100" stroke-dasharray="100 100" transform="rotate(-90 ${cx} ${cy})"/>
    <circle cx="${cx}" cy="${cy - r}" r="11" fill="${C.panel}"/>
    <g class="flame">${icon('flame', cx - 8, cy - r - 9, C.amber, 16)}</g>
    <text x="${cx}" y="${cy + 10}" text-anchor="middle" style="font:700 28px ${SANS};fill:${C.amber}">${d.currentStreak.length}</text>
    <text x="${cx}" y="146" text-anchor="middle" style="font:600 13px ${SANS};fill:${C.amber}">Current Streak</text>
    <text x="${cx}" y="166" text-anchor="middle" style="font:400 10.5px ${SANS};fill:${C.dim}">${esc(d.currentStreak.length ? range(d.currentStreak.start, d.currentStreak.end) : 'Start one today')}</text>
  </g>`;
  const body = `
  <line x1="133" y1="40" x2="133" y2="170" stroke="${C.border}"/>
  <line x1="267" y1="40" x2="267" y2="170" stroke="${C.border}"/>
  ${col(67, 0, kfmt(d.totalContributions), C.text, 'Total Contributions', C.accent, `${dShort(d.firstDay)}, ${d.firstDay.slice(0, 4)} – Present`)}
  ${mid}
  ${col(333, 2, String(d.longestStreak.length), C.text, 'Longest Streak', C.accent, d.longestStreak.length ? range(d.longestStreak.start, d.longestStreak.end) : '—')}`;
  return frame({
    w: 400, h: 200, body, label: 'Contribution streak',
    extraStyle: `.ring{animation:ring 1.6s cubic-bezier(.2,.8,.2,1) .3s both}@keyframes ring{from{stroke-dasharray:0 100}}
  .flame{transform-box:fill-box;transform-origin:50% 100%;animation:flick 1.8s ease-in-out infinite}
  @keyframes flick{0%,100%{transform:scale(1)}50%{transform:scale(1.15) rotate(-4deg)}}`,
  });
}

const TIERS = [
  { name: 'Rookie', color: '#64748b' },
  { name: 'Bronze', color: '#d08b4f' },
  { name: 'Silver', color: '#cbd5e1' },
  { name: 'Gold', color: '#fbbf24' },
  { name: 'Platinum', color: '#67e8f9' },
  { name: 'Diamond', color: '#c4b5fd' },
];
const tierOf = (v, steps) => TIERS[steps.filter((s) => v >= s).length];

export function trophiesCard(d) {
  const items = [
    ['Contributions', d.totalContributions, [100, 500, 1000, 2500, 5000]],
    ['Commits', d.totalCommits, [100, 500, 1000, 2500, 5000]],
    ['Pull Requests', d.pullRequests, [10, 50, 100, 250, 500]],
    ['Repositories', d.repos, [10, 30, 50, 100, 200]],
    ['Stars', d.stars, [10, 50, 100, 500, 1000]],
    ['Years Coding', d.years, [1, 2, 4, 6, 8]],
  ];
  const tw = 114, th = 64, gx = 9, gy = 8, x0 = 20, y0 = 52;
  const tiles = items
    .map(([name, val, steps], i) => {
      const t = tierOf(val, steps);
      const x = x0 + (i % 3) * (tw + gx), y = y0 + Math.floor(i / 3) * (th + gy);
      const glow = TIERS.indexOf(t) >= 3 ? ` class="glow"` : '';
      return `<g class="f" ${delay(i, 0.15, 0.07)}>
    <rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="9" fill="${C.tile}" stroke="${t.color}" stroke-opacity=".35"/>
    <circle${glow} cx="${x + 21}" cy="${y + 32}" r="14" fill="${t.color}" fill-opacity=".12"/>
    ${icon('trophy', x + 12, y + 23, t.color, 18)}
    <text x="${x + 42}" y="${y + 26}" style="font:700 15px ${SANS};fill:${C.text}">${kfmt(val)}</text>
    <text x="${x + 42}" y="${y + 41}" style="font:400 10px ${SANS};fill:${C.muted}">${name}</text>
    <text x="${x + 42}" y="${y + 55}" style="font:700 9px ${SANS};fill:${t.color};letter-spacing:.08em">${t.name.toUpperCase()}</text>
  </g>`;
    })
    .join('\n');
  return frame({
    w: 400, h: 200, title: 'Trophies', sub: 'auto-ranked', body: tiles, label: 'GitHub trophies',
    extraStyle: `.glow{animation:gl 2.8s ease-in-out infinite}@keyframes gl{0%,100%{fill-opacity:.1}50%{fill-opacity:.32}}`,
  });
}

export function activityCard(d, { weeks = 52, w = 820 } = {}) {
  const h = 260;
  const series = d.weekly.slice(-weeks);
  const total = series.reduce((a, s) => a + s.count, 0);
  const max = Math.max(4, ...series.map((s) => s.count));
  const niceMax = Math.ceil(max / 4) * 4;
  const px0 = 46, px1 = w - 24, py0 = 62, py1 = 206;
  const X = (i) => px0 + (i / Math.max(1, series.length - 1)) * (px1 - px0);
  const Y = (v) => py1 - (v / niceMax) * (py1 - py0);
  const pts = series.map((s, i) => [X(i), Y(s.count)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${px1} ${py1} L${px0} ${py1} Z`;
  const grid = [0, 0.5, 1]
    .map((f) => {
      const v = Math.round(niceMax * f), y = Y(v);
      return `<line x1="${px0}" y1="${y}" x2="${px1}" y2="${y}" stroke="${C.border}" stroke-dasharray="${f ? '3 4' : '0'}"/><text x="${px0 - 8}" y="${y + 4}" text-anchor="end" style="font:400 11px ${MONO};fill:${C.dim}">${v}</text>`;
    })
    .join('');
  const step = weeks > 30 ? 1 : 2;
  let lastMonth = -1, shown = 0, lastX = -Infinity;
  const minGap = step > 1 ? 0 : 34;
  const months = series
    .map((s, i) => {
      const m = parseDay(s.start).getUTCMonth();
      if (m === lastMonth) return '';
      lastMonth = m;
      if (i === 0 && parseDay(s.start).getUTCDate() > 7) return '';
      if (shown++ % step || X(i) - lastX < minGap) return '';
      lastX = X(i);
      return `<text x="${X(i)}" y="${py1 + 22}" text-anchor="middle" style="font:400 11px ${SANS};fill:${C.dim}">${MONTHS[m]}</text>`;
    })
    .join('');
  const peakI = series.reduce((b, s, i) => (s.count > series[b].count ? i : b), 0);
  const [pkx, pky] = pts[peakI] || [0, 0];
  const peakLabel = `${series[peakI]?.count ?? 0} in a week`;
  const lblW = textW(peakLabel, 11) + 16;
  const lblX = Math.min(Math.max(pkx - lblW / 2, px0), px1 - lblW);
  const body = `
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.accent}" stop-opacity=".35"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></linearGradient>
    <linearGradient id="ln" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.accent2}"/><stop offset=".5" stop-color="${C.accent}"/><stop offset="1" stop-color="${C.green}"/></linearGradient>
  </defs>
  ${grid}
  <path class="area" d="${area}" fill="url(#area)"/>
  <path class="line" d="${line}" fill="none" stroke="url(#ln)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" pathLength="1"/>
  ${months}
  <g class="pk">
    <circle cx="${pkx}" cy="${pky}" r="4.5" fill="${C.amber}"/>
    <circle cx="${pkx}" cy="${pky}" r="4.5" fill="none" stroke="${C.amber}"><animate attributeName="r" values="4.5;12;4.5" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values=".9;0;.9" dur="2.4s" repeatCount="indefinite"/></circle>
    <rect x="${lblX}" y="${Math.max(pky - 34, 44)}" width="${lblW}" height="20" rx="6" fill="${C.tile}" stroke="${C.amber}" stroke-opacity=".5"/>
    <text x="${lblX + lblW / 2}" y="${Math.max(pky - 34, 44) + 14}" text-anchor="middle" style="font:600 11px ${SANS};fill:${C.amber}">${peakLabel}</text>
  </g>`;
  return frame({
    w, h, title: 'Contribution Activity', sub: w < 500 ? `${kfmt(total)} in ${weeks} wks` : `last ${weeks} weeks · ${kfmt(total)} contributions`, body, label: 'Contribution activity graph',
    extraStyle: `.line{stroke-dasharray:1;animation:draw 2.2s cubic-bezier(.4,0,.2,1) .2s both}
  @keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
  .area{animation:ar 1.2s ease 1.2s both}@keyframes ar{from{opacity:0}to{opacity:1}}
  .pk{animation:ar .6s ease 2.2s both}`,
  });
}

export function repoCard(r) {
  const w = 400, h = 124;
  const name = truncate(r.name, 15, 330, true);
  const forkLine = r.parent ? `<text x="44" y="54" style="font:400 11px ${SANS};fill:${C.dim}">forked from ${esc(truncate(r.parent, 11, 300))}</text>` : '';
  const descY = r.parent ? 74 : 62;
  const lines = r.description ? wrap(r.description, 12.5, 352, r.parent ? 1 : 2) : ['No description provided.'];
  const desc = lines
    .map((l, i) => `<text x="24" y="${descY + i * 18}" style="font:400 12.5px ${SANS};fill:${r.description ? C.muted : C.dim}">${esc(l)}</text>`)
    .join('');
  let fx = 24;
  const meta = [];
  if (r.language) {
    meta.push(`<circle cx="${fx + 5}" cy="102" r="5" fill="${r.languageColor || C.accent}"/><text x="${fx + 15}" y="106" style="font:400 12px ${SANS};fill:${C.muted}">${esc(r.language)}</text>`);
    fx += 15 + textW(r.language, 12) + 18;
  }
  meta.push(`${icon('starSolid', fx, 95, C.amber, 13)}<text x="${fx + 18}" y="106" style="font:400 12px ${SANS};fill:${C.muted}">${kfmt(r.stars)}</text>`);
  fx += 18 + textW(kfmt(r.stars), 12) + 18;
  meta.push(`${icon('fork', fx, 95, C.muted, 13)}<text x="${fx + 18}" y="106" style="font:400 12px ${SANS};fill:${C.muted}">${kfmt(r.forks)}</text>`);
  const body = `
  <g class="f" ${delay(0, 0.05)}>${icon('repo', 22, 23, C.accent, 15)}<text x="44" y="36" style="font:700 15px ${SANS};fill:${C.accent}">${esc(name)}</text>${forkLine}</g>
  <g class="f" ${delay(1, 0.05)}>${desc}</g>
  <g class="f" ${delay(2, 0.05)}>${meta.join('')}</g>`;
  return frame({ w, h, body, label: `Repository ${r.name}` });
}

/* ─────────────────────────────── data ─────────────────────────────── */

async function gql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-cards' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors || json).slice(0, 500)}`);
  return json.data;
}

export async function fetchData(token, login, featured) {
  const base = await gql(token, `query($login:String!){user(login:$login){
    login createdAt followers{totalCount}
    pullRequests{totalCount} issues{totalCount}
    contributionsCollection{contributionYears}
  }}`, { login });
  const u = base.user;
  if (!u) throw new Error(`User ${login} not found`);

  // All owned repos (private ones too when the token can see them).
  const repos = [];
  let after = null, totalRepos = 0;
  do {
    const page = await gql(token, `query($login:String!,$after:String){user(login:$login){repositories(ownerAffiliations:OWNER,first:100,after:$after){
      totalCount pageInfo{hasNextPage endCursor}
      nodes{name isFork stargazerCount languages(first:10,orderBy:{field:SIZE,direction:DESC}){edges{size node{name color}}}}
    }}}`, { login, after });
    const rp = page.user.repositories;
    totalRepos = rp.totalCount;
    repos.push(...rp.nodes);
    after = rp.pageInfo.hasNextPage ? rp.pageInfo.endCursor : null;
  } while (after);

  // One aliased query for every contribution year.
  const now = new Date();
  const years = [...u.contributionsCollection.contributionYears].sort();
  const yq = years
    .map((y) => {
      const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
      return `y${y}:contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${to}"){totalCommitContributions restrictedContributionsCount contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}`;
    })
    .join('\n');
  const yearsData = (await gql(token, `query($login:String!){user(login:$login){${yq}}}`, { login })).user;

  // Featured repos.
  const fq = featured
    .map((f, i) => {
      const [owner, name] = f.includes('/') ? f.split('/') : [login, f];
      return `r${i}:repository(owner:"${owner}",name:"${name}"){name description stargazerCount forkCount primaryLanguage{name color} parent{nameWithOwner}}`;
    })
    .join('\n');
  const fr = featured.length ? await gql(token, `query{${fq}}`, {}).catch((e) => { console.warn('featured:', e.message); return {}; }) : {};

  return { user: u, repos, totalRepos, years, yearsData, featured: featured.map((_, i) => fr[`r${i}`]).filter(Boolean) };
}

export function compute(raw, ignore = CONFIG.ignoreLanguages) {
  const { user, repos, totalRepos, years, yearsData } = raw;

  const dayMap = new Map();
  let totalContributions = 0, totalCommits = 0;
  for (const y of years) {
    const c = yearsData[`y${y}`];
    totalContributions += c.contributionCalendar.totalContributions;
    totalCommits += c.totalCommitContributions;
    for (const w of c.contributionCalendar.weeks) for (const day of w.contributionDays) dayMap.set(day.date, day.contributionCount);
  }
  const today = new Date().toISOString().slice(0, 10);
  const days = [...dayMap.entries()].filter(([d]) => d <= today).sort(([a], [b]) => (a < b ? -1 : 1));

  // Streaks
  let longest = { length: 0, start: null, end: null }, run = { length: 0, start: null, end: null };
  for (const [date, n] of days) {
    if (n > 0) { run = run.length ? { ...run, length: run.length + 1, end: date } : { length: 1, start: date, end: date }; if (run.length > longest.length) longest = { ...run }; }
    else run = { length: 0, start: null, end: null };
  }
  let i = days.length - 1;
  if (i >= 0 && days[i][1] === 0) i--; // today not contributed yet ≠ broken streak
  const cur = { length: 0, start: null, end: null };
  for (; i >= 0 && days[i][1] > 0; i--) { cur.length++; cur.start = days[i][0]; cur.end ??= days[i][0]; }

  // Last 365 days + weekly buckets
  const last = days.slice(-365);
  const yearContributions = last.reduce((a, [, n]) => a + n, 0);
  const activeDaysYear = last.filter(([, n]) => n > 0).length;
  const weekly = [];
  const tail = days.slice(-7 * 52);
  for (let k = 0; k < tail.length; k += 7) {
    const chunk = tail.slice(k, k + 7);
    weekly.push({ start: chunk[0][0], count: chunk.reduce((a, [, n]) => a + n, 0) });
  }

  // Languages
  const sizes = new Map();
  for (const r of repos) {
    if (r.isFork) continue;
    for (const e of r.languages.edges) {
      if (ignore.includes(e.node.name)) continue;
      const cur = sizes.get(e.node.name) || { size: 0, color: e.node.color };
      cur.size += e.size;
      sizes.set(e.node.name, cur);
    }
  }
  const langTotal = [...sizes.values()].reduce((a, v) => a + v.size, 0) || 1;
  const languages = [...sizes.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 8)
    .map(([name, v], k) => ({ name, pct: (v.size / langTotal) * 100, color: v.color || FALLBACK_LANG_COLORS[k % 8] }));

  const created = new Date(user.createdAt);
  return {
    login: user.login,
    totalContributions, totalCommits,
    pullRequests: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    followers: user.followers.totalCount,
    stars: repos.reduce((a, r) => a + r.stargazerCount, 0),
    repos: totalRepos,
    years: Math.max(1, Math.floor((Date.now() - created) / (365.25 * 864e5))),
    firstDay: days.find(([, n]) => n > 0)?.[0] || days[0]?.[0] || today,
    currentStreak: cur, longestStreak: longest,
    yearContributions, activeDaysYear, weekly, languages,
    featured: raw.featured.map((r) => ({
      name: r.name, description: r.description, stars: r.stargazerCount, forks: r.forkCount,
      language: r.primaryLanguage?.name, languageColor: r.primaryLanguage?.color, parent: r.parent?.nameWithOwner,
    })),
  };
}

/* Deterministic fake data so the layout can be previewed without a token. */
export function mockRaw(login = CONFIG.login, featured = CONFIG.featured) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const now = new Date();
  const years = [2022, 2023, 2024, 2025, 2026];
  const yearsData = {};
  for (const y of years) {
    const start = new Date(Date.UTC(y, y === 2022 ? 8 : 0, 1));
    const end = y === now.getUTCFullYear() ? now : new Date(Date.UTC(y, 11, 31));
    const daysArr = [];
    for (let t = +start; t <= +end; t += 864e5) {
      const busy = 0.35 + 0.35 * Math.sin(t / 2.6e9) + (y - 2022) * 0.06;
      daysArr.push({ date: new Date(t).toISOString().slice(0, 10), contributionCount: rnd() < busy ? Math.floor(rnd() * 9) + 1 : 0 });
    }
    const total = daysArr.reduce((a, x) => a + x.contributionCount, 0);
    const weeks = [];
    for (let k = 0; k < daysArr.length; k += 7) weeks.push({ contributionDays: daysArr.slice(k, k + 7) });
    yearsData[`y${y}`] = { totalCommitContributions: Math.round(total * 0.78), restrictedContributionsCount: 0, contributionCalendar: { totalContributions: total, weeks } };
  }
  const L = (name, color, size) => ({ size, node: { name, color } });
  return {
    user: { login, createdAt: '2022-09-20T00:00:00Z', followers: { totalCount: 16 }, pullRequests: { totalCount: 74 }, issues: { totalCount: 12 } },
    totalRepos: 64,
    repos: [
      { name: 'a', isFork: false, stargazerCount: 3, languages: { edges: [L('JavaScript', '#f1e05a', 900000), L('TypeScript', '#3178c6', 600000)] } },
      { name: 'b', isFork: false, stargazerCount: 12, languages: { edges: [L('TypeScript', '#3178c6', 500000), L('Python', '#3572A5', 220000)] } },
      { name: 'c', isFork: false, stargazerCount: 5, languages: { edges: [L('C++', '#f34b7d', 120000), L('Java', '#b07219', 90000), L('Solidity', '#AA6746', 60000), L('Shell', '#89e051', 20000), L('C', '#555555', 30000)] } },
    ],
    years, yearsData,
    featured: [
      { name: featured[0], description: 'NIT Patna official website, deployed on Amazon AWS EC2', stargazerCount: 1, forkCount: 0, primaryLanguage: { name: 'JavaScript', color: '#f1e05a' }, parent: { nameWithOwner: 'nitp-website/nitp-main-website-ec2' } },
      { name: featured[1], description: 'Faculty performance appraisal proforma with role-based workflows and exports', stargazerCount: 1, forkCount: 2, primaryLanguage: { name: 'TypeScript', color: '#3178c6' }, parent: null },
      { name: featured[2], description: 'Conference details : Frontiers in nanomaterials sciences: Aspects in biotechnology and chemical engineering', stargazerCount: 3, forkCount: 1, primaryLanguage: { name: 'JavaScript', color: '#f1e05a' }, parent: null },
      { name: featured[3], description: null, stargazerCount: 1, forkCount: 1, primaryLanguage: { name: 'JavaScript', color: '#f1e05a' }, parent: null },
    ],
  };
}

/* ─────────────────────────────── main ─────────────────────────────── */

export async function renderAll(d, out) {
  await mkdir(out, { recursive: true });
  const files = {
    'stats.svg': statsCard(d),
    'languages.svg': languagesCard(d),
    'streak.svg': streakCard(d),
    'trophies.svg': trophiesCard(d),
    'activity.svg': activityCard(d, { weeks: 52, w: 820 }),
    'activity-mobile.svg': activityCard(d, { weeks: 26, w: 400 }),
  };
  d.featured.forEach((r, i) => { files[`repo-${i + 1}.svg`] = repoCard(r); });
  for (const [f, svg] of Object.entries(files)) await writeFile(path.join(out, f), svg);
  return Object.keys(files);
}

async function main() {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'dist';
  let raw;
  if (args.includes('--mock')) raw = mockRaw();
  else {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Set GH_TOKEN (or run with --mock)');
    raw = await fetchData(token, CONFIG.login, CONFIG.featured);
  }
  const d = compute(raw);
  const files = await renderAll(d, out);
  console.log(`Wrote ${files.length} cards to ${out}/ — ${d.totalContributions} contributions, streak ${d.currentStreak.length}d, ${d.languages.length} languages`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
