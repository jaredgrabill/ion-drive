/**
 * StatusDot — 8px status indicator dot with screen-reader text.
 *
 * Maps a semantic status to the `--status-*` tokens. `pulse` adds the
 * `pulse-glow` animation (disabled under `prefers-reduced-motion`). The
 * status is always exposed as `sr-only` text so color is never the only
 * signal (WCAG 1.4.1).
 *
 * @example
 * ```tsx
 * <StatusDot status="healthy" pulse />
 * ```
 */

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export type SystemStatus = 'healthy' | 'warning' | 'error' | 'idle';

export interface StatusDotProps extends ComponentPropsWithoutRef<'span'> {
  /** Semantic status; resolves to the matching `--status-*` token. */
  status: SystemStatus;
  /** Adds a slow glow pulse (used for the live system indicator). */
  pulse?: boolean;
  /** Screen-reader label; defaults to the status name. */
  label?: string;
}

const statusClasses: Record<SystemStatus, string> = {
  healthy: 'bg-status-healthy',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  idle: 'bg-status-idle',
};

// --- Component -------------------------------------------------------

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(
  ({ className, status, pulse = false, label, ...props }, ref) => (
    <span ref={ref} className={cn('inline-flex items-center', className)} {...props}>
      <span
        aria-hidden
        className={cn(
          'inline-block h-2 w-2 rounded-full',
          statusClasses[status],
          pulse && 'animate-pulse-glow',
        )}
      />
      <span className="sr-only">{label ?? status}</span>
    </span>
  ),
);
StatusDot.displayName = 'StatusDot';
