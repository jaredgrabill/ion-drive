/**
 * Space-themed terminal UI toolkit for the Ion Drive CLI.
 *
 * Ion Drive is space-themed, so the CLI leans into it: a nebula gradient banner,
 * a cosmic colour palette, moon-phase spinners, star bullets, and rounded panels
 * — the kind of polished output you see from npm/docker/claude. Everything here
 * is self-contained (chalk only, no extra deps) and degrades gracefully when
 * colour is unavailable (chalk auto-detects TTY/NO_COLOR).
 */

import chalk from 'chalk';

// --- Cosmic palette -------------------------------------------------------

/** Named brand colours as chalk hex functions. */
export const c = {
  nebula: chalk.hex('#7c5cff'), // primary purple
  cyan: chalk.hex('#22d3ee'), // ion cyan
  star: chalk.hex('#fbbf24'), // star gold
  plasma: chalk.hex('#f472b6'), // plasma pink
  comet: chalk.hex('#38bdf8'), // comet blue
  success: chalk.hex('#34d399'),
  danger: chalk.hex('#fb7185'),
  warn: chalk.hex('#fbbf24'),
  meteor: chalk.hex('#94a3b8'), // muted gray
  dim: chalk.dim,
  bold: chalk.bold,
};

/** Glyphs used throughout the CLI. */
export const sym = {
  star: '✦',
  starDim: '✧',
  rocket: '🚀',
  planet: '🪐',
  satellite: '📡',
  sparkle: '✨',
  orbit: '◍',
  arrow: c.nebula('➜'),
  check: c.success('✔'),
  cross: c.danger('✖'),
  warn: c.warn('▲'),
  info: c.cyan('◆'),
  bullet: c.nebula('✦'),
  dot: c.meteor('·'),
};

// --- Gradient -------------------------------------------------------------

/** Linearly interpolates a hex colour between two endpoints. */
function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const ch = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(a[0], b[0])}${ch(a[1], b[1])}${ch(a[2], b[2])}`;
}

/** Paints text with a nebula→cyan horizontal gradient (per character). */
export function gradient(text: string): string {
  const from: [number, number, number] = [0x7c, 0x5c, 0xff];
  const to: [number, number, number] = [0x22, 0xd3, 0xee];
  const chars = [...text];
  return chars
    .map((chr, i) => {
      if (chr.trim() === '') return chr;
      const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
      return chalk.hex(lerpColor(from, to, t))(chr);
    })
    .join('');
}

// --- Banner ---------------------------------------------------------------

const BANNER_ART = String.raw`
 ██╗ ██████╗ ███╗   ██╗    ██████╗ ██████╗ ██╗██╗   ██╗███████╗
 ██║██╔═══██╗████╗  ██║    ██╔══██╗██╔══██╗██║██║   ██║██╔════╝
 ██║██║   ██║██╔██╗ ██║    ██║  ██║██████╔╝██║██║   ██║█████╗
 ██║██║   ██║██║╚██╗██║    ██║  ██║██╔══██╗██║╚██╗ ██╔╝██╔══╝
 ██║╚██████╔╝██║ ╚████║    ██████╔╝██║  ██║██║ ╚████╔╝ ███████╗
 ╚═╝ ╚═════╝ ╚═╝  ╚═══╝    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝  ╚══════╝`;

/** Renders the gradient banner + tagline. */
export function banner(tagline = 'accelerated business software, at ludicrous speed'): string {
  const art = BANNER_ART.split('\n')
    .map((line) => gradient(line))
    .join('\n');
  const stars = c.meteor(
    `        ${sym.starDim}   ${sym.star}      ${sym.starDim}        ${sym.star}   ${sym.starDim}`,
  );
  return `${art}\n${stars}\n   ${sym.planet} ${c.meteor(tagline)}\n`;
}

// --- Spinner --------------------------------------------------------------

/** A moon-phase "orbit" spinner for ora ({ interval, frames }). */
export const orbitSpinner = {
  interval: 90,
  frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
};

// --- Line printers --------------------------------------------------------

export const log = {
  raw: (msg = '') => console.log(msg),
  step: (msg: string) => console.log(`${sym.arrow} ${msg}`),
  success: (msg: string) => console.log(`${sym.check} ${msg}`),
  error: (msg: string) => console.log(`${sym.cross} ${c.danger(msg)}`),
  warn: (msg: string) => console.log(`${sym.warn} ${c.warn(msg)}`),
  info: (msg: string) => console.log(`${sym.info} ${msg}`),
  bullet: (msg: string) => console.log(`  ${sym.bullet} ${msg}`),
  dim: (msg: string) => console.log(c.dim(msg)),
  heading: (msg: string) => console.log(`\n${c.bold(gradient(msg))}\n`),
};

// --- Box panel ------------------------------------------------------------

/** Visible (emoji-aware) length of a string, ignoring ANSI colour codes. */
function visibleWidth(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  const stripped = s.replace(/\[[0-9;]*m/g, '');
  let width = 0;
  for (const chr of stripped) {
    const code = chr.codePointAt(0) ?? 0;
    // Emoji / wide code points render two columns in most terminals.
    width += code > 0x1f000 || (code >= 0x2600 && code <= 0x27bf) ? 2 : 1;
  }
  return width;
}

/** Draws a rounded cosmic panel around the given lines with an optional title. */
export function box(title: string, lines: string[]): string {
  const paint = c.nebula;
  const width = Math.max(visibleWidth(title) + 2, ...lines.map((l) => visibleWidth(l)), 40) + 2;
  const top = `${paint('╭')}${paint('─')} ${c.bold(gradient(title))} ${paint('─'.repeat(Math.max(0, width - visibleWidth(title) - 3)))}${paint('╮')}`;
  const body = lines.map((l) => {
    const pad = ' '.repeat(Math.max(0, width - visibleWidth(l)));
    return `${paint('│')} ${l}${pad}${paint('│')}`;
  });
  const bottom = `${paint('╰')}${paint('─'.repeat(width + 1))}${paint('╯')}`;
  return [top, ...body, bottom].join('\n');
}

// --- Table ----------------------------------------------------------------

/** Renders a compact aligned table with a cosmic header underline. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ''))),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visibleWidth(s)));
  const headerLine = headers.map((h, i) => c.bold(c.cyan(pad(h, widths[i] ?? 0)))).join('   ');
  const rule = c.meteor(widths.map((w) => '─'.repeat(w)).join('───'));
  const bodyLines = rows.map((r) => r.map((cell, i) => pad(cell, widths[i] ?? 0)).join('   '));
  return [headerLine, rule, ...bodyLines].join('\n');
}
