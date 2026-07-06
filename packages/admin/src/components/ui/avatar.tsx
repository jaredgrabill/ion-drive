/**
 * Avatar — initials circle with deterministic accent tint.
 *
 * Derives up to two initials from `name` (or the first letter of an email)
 * and a stable background hue from a hash of the string, drawn from the ion
 * accent palette. No image support yet — Ion Drive accounts have no avatars.
 *
 * @example
 * ```tsx
 * <Avatar name="Ada Lovelace" />
 * ```
 */

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface AvatarProps extends ComponentPropsWithoutRef<'span'> {
  /** Display name or email to derive initials from. */
  name: string;
  /** Diameter; defaults to `md` (28px). */
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = { sm: 'h-6 w-6 text-[10px]', md: 'h-7 w-7 text-xs', lg: 'h-9 w-9 text-sm' };

const tintClasses = [
  'bg-ion-blue/15 text-ion-blue',
  'bg-ion-purple/15 text-ion-purple',
  'bg-ion-cyan/15 text-ion-cyan',
  'bg-ion-green/15 text-ion-green',
  'bg-ion-amber/15 text-ion-amber',
];

/** Stable tiny hash for picking a tint. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** "Ada Lovelace" → "AL"; "ada@example.com" → "A". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0]?.[0] ?? '?').toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}

// --- Component -------------------------------------------------------

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(
  ({ className, name, size = 'md', ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium',
        sizeClasses[size],
        tintClasses[hashString(name) % tintClasses.length],
        className,
      )}
      {...props}
    >
      {initialsOf(name)}
    </span>
  ),
);
Avatar.displayName = 'Avatar';
