/**
 * CommandPalette — global ⌘K search and action palette, built on `cmdk`.
 *
 * Sections: Recent (last 5 visited pages, persisted via use-local-storage),
 * Pages (all navigable pages), Data Objects (live from the schema API),
 * Records (global record search — the debounced query fans out as Phase 7
 * `q=` free-text searches across the first few non-system objects; results
 * are server-matched, so their item values are prefixed with the live query
 * to pass cmdk's client filter, and selecting one opens the object's grid
 * with the term prefilled via the grid-prefill sessionStorage handoff — see
 * lib/grid-prefill), and Actions (create object,
 * toggle dark mode, copy API base URL). Opening is controlled by the parent
 * (AppShell registers the ⌘K shortcut; the header pill also opens it).
 * Arrow keys navigate, Enter selects, Escape closes — all provided by cmdk,
 * which renders inside a Radix Dialog for focus trap.
 */

import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  Activity,
  Blocks,
  CalendarClock,
  Database,
  FileText,
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
import { useEffect, useMemo, useState } from 'react';
import { useDarkMode, useDebounce, useLocalStorage } from '../../hooks';
import { api } from '../../lib/api';
import { setGridSearchPrefill } from '../../lib/grid-prefill';
import { displayFieldOf, recordLabelOf } from '../../lib/record-label';
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

const groupClass =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.05em] [&_[cmdk-group-heading]]:text-muted-foreground';

/** Record search fans out across at most this many non-system objects. */
const RECORD_SEARCH_OBJECT_CAP = 8;
/** Minimum typed characters before the record search fires. */
const RECORD_SEARCH_MIN_CHARS = 2;
/** Results requested per object. */
const RECORD_SEARCH_PAGE_SIZE = 3;

// --- Component -------------------------------------------------------

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [, toggleDark] = useDarkMode();
  const [recent, setRecent] = useLocalStorage<string[]>('ion-recent-pages', []);
  const [query, setQuery] = useState('');

  // Clear the query when the palette closes so it reopens fresh.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const objects = useQuery({
    queryKey: ['objects'],
    queryFn: () => api.listObjects(),
    enabled: open,
  });

  // --- Global record search (debounced fan-out across objects) ---
  const term = useDebounce(query.trim(), 300);
  const searchTerm = term.length >= RECORD_SEARCH_MIN_CHARS ? term : '';
  const searchableObjects = useMemo(
    () => (objects.data ?? []).filter((o) => !o.isSystem).slice(0, RECORD_SEARCH_OBJECT_CAP),
    [objects.data],
  );
  const searching = open && searchTerm !== '';

  const recordResults = useQueries({
    queries: searchableObjects.map((o) => ({
      queryKey: ['palette-records', o.name, searchTerm],
      queryFn: () =>
        api.listRecords(
          o.name,
          `?pageSize=${RECORD_SEARCH_PAGE_SIZE}&q=${encodeURIComponent(searchTerm)}`,
        ),
      enabled: searching,
      staleTime: 15_000,
    })),
  });
  // Object definitions provide the display-field heuristic for labels; the
  // query key is shared with the rest of the app, so these usually hit cache.
  const objectDefs = useQueries({
    queries: searchableObjects.map((o) => ({
      queryKey: ['object', o.name],
      queryFn: () => api.getObject(o.name),
      enabled: searching,
      staleTime: 60_000,
    })),
  });

  const recordGroups = searching
    ? searchableObjects
        .map((o, i) => ({
          object: o,
          field: displayFieldOf(objectDefs[i]?.data),
          rows: recordResults[i]?.data?.data ?? [],
        }))
        .filter((g) => g.rows.length > 0)
    : [];
  const recordsLoading = searching && recordResults.some((q) => q.isLoading);

  const go = (to: PageTo) => {
    setRecent((prev) => [to, ...prev.filter((p) => p !== to)].slice(0, 5));
    onClose();
    void navigate({ to });
  };

  const goObject = (name: string) => {
    onClose();
    void navigate({ to: '/objects/$name', params: { name } });
  };

  // Opens the object's grid with the search term prefilled, so the selected
  // record is visible (there is no per-record deep link — the grid's own
  // `q=` search reproduces the palette's match).
  const goRecord = (objectName: string) => {
    setGridSearchPrefill(objectName, searchTerm);
    goObject(objectName);
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
          value={query}
          onValueChange={setQuery}
          placeholder="Search pages, objects, records, actions…"
          className="h-11 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Command.List className="max-h-80 overflow-y-auto p-2">
          {/* Hidden while the record search is in flight — the Records
              group's loading row communicates state instead. */}
          {!recordsLoading && (
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </Command.Empty>
          )}

          {recentPages.length > 0 && (
            <Command.Group heading="Recent" className={groupClass}>
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

          <Command.Group heading="Pages" className={groupClass}>
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
            <Command.Group heading="Data Objects" className={groupClass}>
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

          {searching && (recordsLoading || recordGroups.length > 0) && (
            <Command.Group
              heading="Records"
              className={groupClass}
              // While the fan-out is in flight there are no items yet, so the
              // group must be forced visible to show the loading row. Once
              // results exist their items keep the group visible normally.
              forceMount={recordsLoading && recordGroups.length === 0 ? true : undefined}
            >
              {recordsLoading && recordGroups.length === 0 && (
                <Command.Loading>
                  <span className="flex items-center px-2 py-1.5 text-sm text-muted-foreground">
                    Searching records…
                  </span>
                </Command.Loading>
              )}
              {recordGroups.flatMap(({ object: o, field, rows }) =>
                rows.map((row) => {
                  const id = String(row.id);
                  return (
                    <Command.Item
                      key={`record-${o.name}-${id}`}
                      // Results are already server-matched (`q=`), but cmdk
                      // still scores items against the input — prefixing the
                      // live query makes them always match (and count as
                      // results, so Empty hides and Enter auto-selects).
                      value={`${query} record ${recordLabelOf(row, field)} ${o.name} ${id}`}
                      onSelect={() => goRecord(o.name)}
                      className={itemClass}
                    >
                      <FileText />
                      <span className="truncate">{recordLabelOf(row, field)}</span>
                      <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                        {o.displayName}
                      </span>
                    </Command.Item>
                  );
                }),
              )}
            </Command.Group>
          )}

          <Command.Group heading="Actions" className={groupClass}>
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
