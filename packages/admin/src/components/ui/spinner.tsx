/**
 * Spinner — indeterminate loading indicator.
 *
 * A rotating ring in the current foreground color. Includes screen-reader
 * text; size via className (`h-4 w-4` … `h-8 w-8`).
 *
 * @example
 * ```tsx
 * <Spinner className="h-8 w-8" />
 * ```
 */

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface SpinnerProps extends ComponentPropsWithoutRef<'div'> {}

// --- Component -------------------------------------------------------

export const Spinner = forwardRef<HTMLDivElement, SpinnerProps>(({ className, ...props }, ref) => (
  // biome-ignore lint/a11y/useSemanticElements: a spinner has no semantic HTML element
  <div ref={ref} role="status" className={cn('inline-block h-5 w-5', className)} {...props}>
    <div className="h-full w-full animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
    <span className="sr-only">Loading…</span>
  </div>
));
Spinner.displayName = 'Spinner';
