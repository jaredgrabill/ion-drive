/**
 * Header — top bar with breadcrumbs, ⌘K trigger, theme toggle, user menu.
 *
 * Breadcrumbs are auto-derived from the route (left). The search pill opens
 * the CommandPalette (state lives in AppShell). The user menu (Avatar +
 * DropdownMenu) shows the signed-in email and hosts theme/logout actions.
 */

import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Moon, Search, Sun } from 'lucide-react';
import { useDarkMode } from '../../hooks';
import { auth } from '../../lib/auth';
import { useSession } from '../../lib/session';
import {
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
} from '../ui';
import { Breadcrumbs } from './breadcrumbs';

// --- Types -----------------------------------------------------------

export interface HeaderProps {
  /** Opens the command palette. */
  onOpenPalette: () => void;
}

/** True on Apple platforms — decides whether the hint shows ⌘K or Ctrl+K. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

// --- Component -------------------------------------------------------

export function Header({ onOpenPalette }: HeaderProps) {
  const { data: me } = useSession();
  const queryClient = useQueryClient();
  const [dark, toggleDark] = useDarkMode();

  async function logout() {
    await auth.signOut();
    await queryClient.invalidateQueries({ queryKey: ['me'] });
  }

  const identity = me?.user?.name || me?.user?.email || '?';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
      <Breadcrumbs />

      <div className="flex items-center gap-2">
        {/* Command palette trigger */}
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenPalette}
          className="gap-2 text-muted-foreground"
          aria-label="Open command palette"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search…</span>
          <Kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</Kbd>
        </Button>

        {/* Theme toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleDark}
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="User menu"
            >
              <Avatar name={identity} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">{me?.user?.name ?? 'Account'}</span>
              <span className="font-normal">{me?.user?.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={toggleDark}>
              {dark ? <Sun /> : <Moon />} {dark ? 'Light mode' : 'Dark mode'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => void logout()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
Header.displayName = 'Header';
