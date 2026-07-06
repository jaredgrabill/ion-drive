/**
 * Select — styled native `<select>` with a custom chevron.
 *
 * Deliberately the native element (not a Radix listbox): option lists in the
 * admin console are short, and the native control wins on keyboard/mobile
 * behavior for free. The default appearance is stripped and replaced with the
 * shared border/focus treatment plus an inline SVG chevron.
 *
 * @example
 * ```tsx
 * <Select value={type} onChange={(e) => setType(e.target.value)}>
 *   <option value="text">text</option>
 * </Select>
 * ```
 */

import { ChevronDown } from 'lucide-react';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface SelectProps extends ComponentPropsWithoutRef<'select'> {}

// --- Component -------------------------------------------------------

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        className="flex h-9 w-full appearance-none rounded-md border border-input bg-background py-1 pr-8 pl-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  ),
);
Select.displayName = 'Select';
