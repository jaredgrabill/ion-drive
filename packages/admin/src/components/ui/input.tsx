/**
 * Input — single-line text input styled with the design tokens.
 *
 * A plain `<input>` with the shared border/focus-ring treatment. Use
 * `type="number" | "email" | "url" | ...` as usual; the grid cell editors and
 * form fields all build on this.
 *
 * @example
 * ```tsx
 * <Input placeholder="you@example.com" type="email" />
 * ```
 */

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface InputProps extends ComponentPropsWithoutRef<'input'> {}

// --- Component -------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
