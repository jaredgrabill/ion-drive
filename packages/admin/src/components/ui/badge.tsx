/**
 * Badge — small pill for statuses, tags, and counts.
 *
 * Variants map to the semantic status tokens: `success` (orbit green),
 * `warning` (solar amber), `destructive` (supernova red), `info` (ion blue).
 * Neutral variants (`default`/`secondary`/`outline`) cover tags and counts.
 *
 * @example
 * ```tsx
 * <Badge variant="success">enabled</Badge>
 * ```
 */

import { type VariantProps, cva } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        outline: 'border border-border text-foreground',
        success: 'bg-ion-green/15 text-ion-green',
        warning: 'bg-ion-amber/15 text-ion-amber',
        destructive: 'bg-destructive/15 text-destructive',
        info: 'bg-ion-blue/15 text-ion-blue',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
);

export interface BadgeProps
  extends ComponentPropsWithoutRef<'span'>,
    VariantProps<typeof badgeVariants> {}

// --- Component -------------------------------------------------------

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = 'Badge';
