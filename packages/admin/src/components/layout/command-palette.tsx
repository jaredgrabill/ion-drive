/**
 * CommandPalette — global ⌘K search and action palette, built on `cmdk`.
 *
 * Sections: Recent (last 5 visited pages, persisted via use-local-storage),
 * Pages (all navigable pages), Data Objects (live from the schema API), and
 * Actions (create object, toggle dark mode, copy API base URL). Opening is
 * controlled by the parent (AppShell registers the ⌘K shortcut; the header
 * pill also opens it). Arrow keys navigate, Enter selects, Escape closes —
 * all provided by cmdk, which renders inside a Radix Dialog for focus trap.
 */

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  Activity,
  Blocks,
  CalendarClock,
  Database,
  History,
  KeyRound,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  Moon,
  Plus,
  ScrollText,
  Settings,
  Shield,
  Users,
} from 'lucide-react';
import { useDarkMode, useLocalStorage } from '../../hooks';
import { api } from '../../lib/api';
import { Dialog, toast } from '../ui';

// --- Page registry ---------------------------------------------------

const PAGES = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/objects', label: 'Data Objects', icon: Database },
  { to: '/blocks', label: 'Building Blocks', icon: Blocks },
  { to: '/tasks', label: 'Tasks', icon: CalendarClock },
  { to: '/users', label: 'Users', icon: Users },
  { to: '/roles', label: 'Roles', icon: Shield },
  { to: '/api-keys', label: 'API Keys', icon: KeyRound },
  { to: '/secrets', label: 'Secrets', icon: LockKeyhole },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/metrics', label: 'Metrics', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

type PageTo = (typeof PAGES)[number]['to'];

/**
 * Session flag read by ObjectsList on mount to auto-open the create dialog
 * (set by the palette's "Create new object" action).
 */
export const CREATE_OBJECT_FLAG = 'ion-open-create-object';

const itemClass =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

// --- Component -------------------------------------------------------

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [, toggleDark] = useDarkMode();
  const [recent, setRecent] = useLocalStorage<string[]>('ion-recent-pages', []);

  const objects = useQuery({
    queryKey: ['objects'],
    queryFn: () => api.listObjects(),
    enabled: open,
  });

  const go = (to: PageTo) => {
    setRecent((prev) => [to, ...prev.filter((p) => p !== to)].slice(0, 5));
    onClose();
    void navigate({ to });
  };

  const goObject = (name: string) => {
    onClose();
    void navigate({ to: '/objects/$name', params: { name } });
  };

  const recentPages = recent
    .map((to) => PAGES.find((p) => p.to === to))
    .filter((p): p is (typeof PAGES)[number] => p !== undefined);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Command palette"
      className="max-w-xl p-0 [&>div:first-child]:hidden"
    >
      <Command label="Command palette" className="flex flex-col">
        <Command.Input
          autoFocus
          placeholder="Search pages, objects, actions…"
          className="h-11 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
            No results found.
          </Command.Empty>

          {recentPages.length > 0 && (
            <Command.Group
              heading="Recent"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.05em] [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {recentPages.map((page) => (
                <Command.Item
                  key={`recent-${page.to}`}
                  value={`recent ${page.label}`}
                  onSelect={() => go(page.to)}
                  className={itemClass}
                >
                  <History /> {page.label}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group
            heading="Pages"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.05em] [&_[cmdk-group-heading]]:text-muted-foreground"
          >
            {PAGES.map((page) => (
              <Command.Item
                key={page.to}
                value={`page ${page.label}`}
                onSelect={() => go(page.to)}
                className={itemClass}
              >
                <page.icon /> {page.label}
              </Command.Item>
            ))}
          </Command.Group>

          {(objects.data ?? []).filter((o) => !o.isSystem).length > 0 && (
            <Command.Group
              heading="Data Objects"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.05em] [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {(objects.data ?? [])
                .filter((o) => !o.isSystem)
                .map((o) => (
                  <Command.Item
                    key={o.name}
                    value={`object ${o.displayName} ${o.name}`}
                    onSelect={() => goObject(o.name)}
                    className={itemClass}
                  >
                    <Database /> {o.displayName}
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      {o.name}
                    </span>
                  </Command.Item>
                ))}
            </Command.Group>
          )}

          <Command.Group
            heading="Actions"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.05em] [&_[cmdk-group-heading]]:text-muted-foreground"
          >
            <Command.Item
              value="action create new object"
              onSelect={() => {
                sessionStorage.setItem(CREATE_OBJECT_FLAG, '1');
                go('/objects');
              }}
              className={itemClass}
            >
              <Plus /> Create new object
            </Command.Item>
            <Command.Item
              value="action toggle dark mode theme"
              onSelect={() => {
                toggleDark();
                onClose();
              }}
              className={itemClass}
            >
              <Moon /> Toggle dark mode
            </Command.Item>
            <Command.Item
              value="action copy api base url"
              onSelect={() => {
                navigator.clipboard?.writeText(`${window.location.origin}/api/v1`);
                toast('Copied API base URL to clipboard');
                onClose();
              }}
              className={itemClass}
            >
              <Link2 /> Copy API base URL
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </Dialog>
  );
}
CommandPalette.displayName = 'CommandPalette';
