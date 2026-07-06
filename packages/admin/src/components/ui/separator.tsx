/**
 * Separator — semantic horizontal/vertical divider built on Radix Separator.
 *
 * @example
 * ```tsx
 * <Separator className="my-4" />
 * <Separator orientation="vertical" className="h-4" />
 * ```
 */

import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Component -------------------------------------------------------

export const Separator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    orientation={orientation}
    decorative={decorative}
    className={cn(
      'shrink-0 bg-border',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className,
    )}
    {...props}
  />
));
Separator.displayName = 'Separator';
