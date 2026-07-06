/**
 * Tabs — underline-style tab strip built on Radix Tabs.
 *
 * The trigger row is a bottom-bordered strip; the active trigger gets a
 * 2px foreground underline (matching the ObjectDetail header design).
 * Compound components (Tabs/TabsList/TabsTrigger/TabsContent) stay in one
 * file per the file-organization rules.
 *
 * @example
 * ```tsx
 * <Tabs defaultValue="data">
 *   <TabsList>
 *     <TabsTrigger value="data">Data</TabsTrigger>
 *     <TabsTrigger value="schema">Schema</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="data">…</TabsContent>
 * </Tabs>
 * ```
 */

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Components ------------------------------------------------------

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('flex gap-1 border-b border-border', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      '-mb-px border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:border-foreground data-[state=active]:text-foreground',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('pt-4 focus-visible:outline-none', className)}
    {...props}
  />
));
TabsContent.displayName = 'TabsContent';
