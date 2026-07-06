/**
 * Kbd — keyboard shortcut chip (⌘K, Esc, ↵ …).
 *
 * Renders in a raised monospace capsule matching command-palette hints.
 * Purely presentational.
 *
 * @example
 * ```tsx
 * <Kbd>⌘K</Kbd>
 * ```
 */

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface KbdProps extends ComponentPropsWithoutRef<'kbd'> {}

// --- Component -------------------------------------------------------

export const Kbd = forwardRef<HTMLElement, KbdProps>(({ className, ...props }, ref) => (
  <kbd
    ref={ref}
    className={cn(
      'pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground',
      className,
    )}
    {...props}
  />
));
Kbd.displayName = 'Kbd';
