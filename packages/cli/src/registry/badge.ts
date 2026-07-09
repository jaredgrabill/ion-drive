/**
 * Static trust/version badge rendering (spec-08 §1).
 *
 * `registry build` emits one `badges/<name>.svg` per block so third-party
 * READMEs can embed a shields-style badge served straight from the registry
 * host (static files only — suite rule 3). Hand-rolled flat template, zero
 * dependencies: two flat rect segments, 20px tall, rounded via a clipPath,
 * white 11px text sized with a per-character width table so the output is
 * fully **deterministic** (no timestamps, no font measurement).
 *
 * Colors come from the repo's dataviz palette and were contrast-validated for
 * white 11px text (WCAG small-text needs ≥ 4.5:1):
 *
 *  - label segment (block name): neutral dark `#52514e` — 7.94:1
 *  - value segment, official:    success-text green `#006300` — 7.54:1
 *    (the lighter status-green `#0ca30c` was REJECTED at 3.35:1)
 *  - value segment, community:   neutral dark gray `#383835` — 11.76:1
 *
 * The trust word is rendered in the text (`… · official`), never color-alone,
 * and it is a **display hint** from the registry index (spec-01 §3) — real
 * trust tiers are computed client-side at add/verify time (spec-04).
 */

/** Input for one badge — taken from a registry index entry. */
export interface BadgeInput {
  name: string;
  /** The block's latest published version (rendered as `v<version>`). */
  version: string;
  /** Index display hint; only the literal `official` earns the green segment. */
  trust?: string;
}

/** Badge geometry/palette constants (shields "flat" conventions). */
const HEIGHT = 20;
const PAD = 6;
const LABEL_FILL = '#52514e';
const OFFICIAL_FILL = '#006300';
const COMMUNITY_FILL = '#383835';

/**
 * Approximate per-character advance widths for 11px Verdana (the shields
 * font stack). Exactness doesn't matter — `textLength` forces the rendered
 * text to fit — but the table must be deterministic so identical input yields
 * identical bytes.
 */
const NARROW = new Set(['i', 'j', 'l', '!', '.', ',', ':', ';', "'", '|']);
const SLIM = new Set(['f', 't', 'r', '(', ')', '[', ']', '-', '/', '\\', ' ', '·']);
const WIDE = new Set(['m', 'w', 'M', 'W', '@', '%']);

/** Deterministic pixel width of `text` at 11px in the badge font stack. */
export function textWidth(text: string): number {
  let width = 0;
  for (const chr of text) {
    if (NARROW.has(chr)) width += 3;
    else if (SLIM.has(chr)) width += 4;
    else if (WIDE.has(chr)) width += 10;
    else if (chr >= 'A' && chr <= 'Z') width += 8;
    else width += 7; // lowercase, digits, everything else
  }
  return width;
}

/** Escapes the five XML-special characters for text/attribute contexts. */
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** One text element centered in its segment, `textLength`-pinned. */
function textEl(centerX: number, width: number, text: string): string {
  return `<text x="${centerX}" y="14" textLength="${width}">${escapeXml(text)}</text>`;
}

/**
 * Renders a complete, deterministic badge SVG (`role="img"` + `<title>` for
 * accessibility). Same input ⇒ byte-identical output, so `registry build`'s
 * idempotency and `--check` drift detection cover badges for free.
 */
export function renderBadgeSvg(input: BadgeInput): string {
  const official = input.trust === 'official';
  const label = input.name;
  const value = `v${input.version} · ${official ? 'official' : 'community'}`;
  const valueFill = official ? OFFICIAL_FILL : COMMUNITY_FILL;

  const labelTextW = textWidth(label);
  const valueTextW = textWidth(value);
  const labelW = labelTextW + PAD * 2;
  const valueW = valueTextW + PAD * 2;
  const total = labelW + valueW;
  const title = `${label}: ${value}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${HEIGHT}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<clipPath id="r"><rect width="${total}" height="${HEIGHT}" rx="3" fill="#fff"/></clipPath>`,
    '<g clip-path="url(#r)" shape-rendering="crispEdges">',
    `<rect width="${labelW}" height="${HEIGHT}" fill="${LABEL_FILL}"/>`,
    `<rect x="${labelW}" width="${valueW}" height="${HEIGHT}" fill="${valueFill}"/>`,
    '</g>',
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
    textEl(labelW / 2, labelTextW, label),
    textEl(labelW + valueW / 2, valueTextW, value),
    '</g>',
    '</svg>',
    '', // trailing newline — the repo-wide text-file convention
  ].join('\n');
}
