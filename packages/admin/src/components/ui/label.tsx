/**
 * Label — form field label with the standard weight/size treatment.
 *
 * Associate with a control via `htmlFor`; when used as a wrapping label
 * (e.g. around a Checkbox) no `htmlFor` is needed.
 *
 * @example
 * ```tsx
 * <Label htmlFor="email">Email</Label>
 * ```
 */

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface LabelProps extends ComponentPropsWithoutRef<'label'> {}

// --- Component -------------------------------------------------------

export const Label = forwardRef<HTMLLabelElement, LabelProps>(({ className, ...props }, ref) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: generic label primitive, associated by callers
  <label
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  />
));
Label.displayName = 'Label';
