/**
 * LogoMark — the Ion Drive visual identity: an escape orbit around a
 * crescent planet.
 *
 * A planet lit from the right (only its crescent is drawn — the dark side is
 * pure negative space) with a trajectory that launches from behind the dark
 * limb, hooks around the planet, and flings a small four-point star (the
 * craft, in `--ion-cyan`) out of the top-right. An SVG mask slightly larger
 * than the planet cuts the path where it passes behind, so the unlit side
 * occludes the orbit and the sphere is implied rather than drawn. Rendered
 * inline in `currentColor` (`--ion-blue` via the default class) with a soft
 * CSS glow, so it follows the theme automatically. Used in the sidebar header
 * and on the login card. Sized via the `size` prop; decorative (`aria-hidden`)
 * because it always appears next to the product name.
 */

import { useId } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface LogoMarkProps {
  /** Pixel size of the square mark (default 20). */
  size?: number;
  className?: string;
}

// --- Component -------------------------------------------------------

export function LogoMark({ size = 20, className }: LogoMarkProps) {
  // Mask ids are document-global in SVG — make them unique per instance.
  const maskId = useId();

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative (aria-hidden) — always accompanied by the product name
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn(
        'shrink-0 text-ion-blue drop-shadow-[0_0_6px_hsl(var(--ion-blue)/0.6)]',
        className,
      )}
    >
      <defs>
        <mask id={maskId}>
          <rect width="24" height="24" fill="white" />
          {/* Planet silhouette (slightly oversized) hides the path passing behind */}
          <circle cx="10" cy="12" r="5.5" fill="black" />
        </mask>
      </defs>
      {/* Escape trajectory — launches from behind the dark limb, hooks around, flings up-right */}
      <path
        d="M 8.4,8.6 C 4.6,8.9 2.6,11.6 2.8,14.2 C 3.0,17.2 6.3,19.9 10.2,19.6 C 13.9,19.32 16.9,16.2 17.5,11.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeOpacity="0.9"
        strokeLinecap="round"
        mask={`url(#${maskId})`}
      />
      {/* Planet crescent, lit from the right — the dark side is negative space */}
      <path d="M10,7.4 A4.6,4.6 0 0 1 10,16.6 A5.91,5.91 0 0 0 10,7.4 Z" fill="currentColor" />
      {/* The craft — a little four-point star escaping along the tangent */}
      <path
        fill="hsl(var(--ion-cyan))"
        transform="translate(17.9,8.4)"
        d="M0,-2.2 C0.3,-0.8 0.8,-0.3 2.2,0 C0.8,0.3 0.3,0.8 0,2.2 C-0.3,0.8 -0.8,0.3 -2.2,0 C-0.8,-0.3 -0.3,-0.8 0,-2.2 Z"
      />
    </svg>
  );
}
LogoMark.displayName = 'LogoMark';
