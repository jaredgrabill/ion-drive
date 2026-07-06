/**
 * Textarea — multi-line text input styled with the design tokens.
 *
 * Used by long-text / rich-text / JSON field editors. Pair with `font-mono`
 * via className for code-like content.
 *
 * @example
 * ```tsx
 * <Textarea rows={6} className="font-mono" />
 * ```
 */

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface TextareaProps extends ComponentPropsWithoutRef<'textarea'> {}

// --- Component -------------------------------------------------------

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
