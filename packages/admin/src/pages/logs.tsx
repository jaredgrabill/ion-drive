/**
 * Logs — structured log viewer with live SSE tailing.
 *
 * Consumes `GET /api/v1/logs` (filtered query) and `GET /api/v1/logs/stream`
 * (Server-Sent Events). Toolbar: level dropdown, source dropdown (from
 * `/logs/sources`), debounced full-text search, and a Live toggle. In live
 * mode new entries stream in at the top with a slide-up animation; level
 * colors appear as a subtle left border (error red / warn amber / info blue /
 * debug gray) *plus* the level badge, so color is never the only signal.
 * Clicking a row expands a detail panel with the structured attributes and
 * a copyable trace id. Filter state persists in URL search params.
 */

import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Copy, Pause, Play } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Input, Select, Skeleton, toast } from '../components/ui';
import { useDebounce } from '../hooks';
import { api } from '../lib/api';
import type { LogEntry, LogLevel } from '../lib/types';
import { cn } from '../lib/utils';

// --- Level presentation --------------------------------------------------

const LEVEL_BADGE: Record<LogLevel, 'destructive' | 'warning' | 'info' | 'secondary'> = {
  error: 'destructive',
  warn: 'warning',
  info: 'info',
  debug: 'secondary',
};

const LEVEL_BORDER: Record<LogLevel, string> = {
  error: 'border-l-ion-red',
  warn: 'border-l-ion-amber',
  info: 'border-l-ion-blue',
  debug: 'border-l-muted-foreground/40',
};

const MAX_LIVE_ENTRIES = 500;

// --- URL param persistence ------------------------------------------------

function readParams(): { level: string; source: string; search: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    level: params.get('level') ?? '',
    source: params.get('source') ?? '',
    search: params.get('search') ?? '',
  };
}

function writeParams(level: string, source: string, search: string): void {
  const params = new URLSearchParams();
  if (level) params.set('level', level);
  if (source) params.set('source', source);
  if (search) params.set('search', search);
  const query = params.toString();
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
}

// --- Page ------------------------------------------------------------------

export function Logs() {
  const initial = useRef(readParams()).current;
  const [level, setLevel] = useState(initial.level);
  const [source, setSource] = useState(initial.source);
  const [searchInput, setSearchInput] = useState(initial.search);
  const search = useDebounce(searchInput, 300);
  const [live, setLive] = useState(false);
  const [liveEntries, setLiveEntries] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => writeParams(level, source, search), [level, source, search]);

  const sources = useQuery({ queryKey: ['log-sources'], queryFn: () => api.logSources() });
  const logs = useQuery({
    queryKey: ['logs', level, source, search],
    queryFn: () =>
      api.queryLogs({
        level: (level || undefined) as LogLevel | undefined,
        source: source || undefined,
        search: search || undefined,
        limit: 200,
      }),
    refetchInterval: live ? false : 15_000,
  });

  // Live SSE tail — prepend matching entries.
  useEffect(() => {
    if (!live) return;
    const eventSource = new EventSource('/api/v1/logs/stream', { withCredentials: true });
    eventSource.onmessage = (event) => {
      const entry = JSON.parse(event.data) as LogEntry;
      if (level && entry.level !== level) return;
      if (source && entry.source !== source) return;
      if (search && !entry.message.toLowerCase().includes(search.toLowerCase())) return;
      setLiveEntries((prev) => [entry, ...prev].slice(0, MAX_LIVE_ENTRIES));
    };
    eventSource.onerror = () => {
      // EventSource retries automatically; nothing to do.
    };
    return () => eventSource.close();
  }, [live, level, source, search]);

  const baseEntries = logs.data?.data ?? [];
  const seen = new Set(baseEntries.map((e) => e.id));
  const entries = [...liveEntries.filter((e) => !seen.has(e.id)), ...baseEntries];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Logs</h1>
        <p className="text-sm text-muted-foreground">
          Recent server logs from the in-memory buffer. For long-term retention, wire up an OTLP
          backend.
        </p>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          className="w-32"
          value={level}
          aria-label="Filter by level"
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">All levels</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </Select>
        <Select
          className="w-40"
          value={source}
          aria-label="Filter by source"
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">All sources</option>
          {(sources.data ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Input
          className="h-9 w-64"
          placeholder="Search messages…"
          aria-label="Search log messages"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <Button
          variant={live ? 'default' : 'outline'}
          size="sm"
          className="ml-auto gap-1.5"
          onClick={() => {
            setLive((prev) => !prev);
            setLiveEntries([]);
          }}
          aria-pressed={live}
        >
          {live ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {live ? 'Pause' : 'Live'}
        </Button>
      </div>

      {/* Log table */}
      {logs.isLoading ? (
        <div className="flex flex-col gap-1" aria-hidden>
          {Array.from({ length: 10 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title="No log entries"
          hint="Interact with the API to generate some activity, or loosen the filters."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-44 px-3 py-2 font-medium">
                  Timestamp
                </th>
                <th scope="col" className="w-20 px-3 py-2 font-medium">
                  Level
                </th>
                <th scope="col" className="w-36 px-3 py-2 font-medium">
                  Source
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Message
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <Fragment key={entry.id}>
                  <tr
                    tabIndex={0}
                    className={cn(
                      'cursor-pointer border-t border-border/60 border-l-2 bg-card transition-colors hover:bg-muted/40 animate-slide-up focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                      LEVEL_BORDER[entry.level],
                      expanded === entry.id && 'bg-muted/40',
                    )}
                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(expanded === entry.id ? null : entry.id);
                      }
                    }}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-muted-foreground">
                      {format(new Date(entry.timestamp), 'MMM d HH:mm:ss.SSS')}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge variant={LEVEL_BADGE[entry.level]}>{entry.level}</Badge>
                    </td>
                    <td className="truncate px-3 py-1.5 font-mono text-xs">{entry.source}</td>
                    <td className="max-w-0 truncate px-3 py-1.5">{entry.message}</td>
                  </tr>
                  {expanded === entry.id && (
                    <tr className="border-t border-border/40 bg-surface-sunken">
                      <td colSpan={4} className="px-4 py-3">
                        <div className="flex flex-col gap-2">
                          {entry.traceId && (
                            <div className="flex items-center gap-2 text-xs">
                              <span className="text-muted-foreground">Trace ID</span>
                              <code className="font-mono">{entry.traceId}</code>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Copy trace id"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard?.writeText(entry.traceId ?? '');
                                  toast('Copied trace id');
                                }}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                          {Object.keys(entry.attributes).length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No structured attributes.
                            </p>
                          ) : (
                            <table className="w-full text-xs">
                              <tbody>
                                {Object.entries(entry.attributes).map(([key, value]) => (
                                  <tr key={key} className="align-top">
                                    <td className="w-48 py-0.5 pr-4 font-mono text-muted-foreground">
                                      {key}
                                    </td>
                                    <td className="break-all py-0.5 font-mono">
                                      {typeof value === 'object'
                                        ? JSON.stringify(value)
                                        : String(value)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
Logs.displayName = 'Logs';
