/**
 * Popover — positioned floating panel built on Radix Popover.
 *
 * The base for the grid's FilterBuilder, SortBuilder, and field-visibility
 * panels. Content renders in a portal on the elevated surface token.
 *
 * @example
 * ```tsx
 * <Popover>
 *   <PopoverTrigger asChild><Button variant="outline">Filter</Button></PopoverTrigger>
 *   <PopoverContent align="start">…</PopoverContent>
 * </Popover>
 * ```
 */

import * as PopoverPrimitive from '@radix-ui/react-popover';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Components ------------------------------------------------------

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none animate-slide-up',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';
