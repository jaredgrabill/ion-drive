/**
 * Events — the message bus's operational surface (Phase 12 / ADR-019).
 *
 * Two tabs:
 *  - **Deliveries** — the `_ion_event_deliveries` ledger joined to events:
 *    filter by status/consumer, or flip the "Dead only" switch for the DLQ
 *    view (failed + retry budget exhausted). Failed rows get a Retry button
 *    that revives the delivery and nudges the dispatcher.
 *  - **Live feed** — a realtime tail of `GET /api/v1/events/stream` over
 *    EventSource (cookie auth), newest first, with topic filter.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { Pause, Play, Radio, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '../components/ui';
import { useDebounce } from '../hooks';
import { ApiError, api } from '../lib/api';
import type { DeliveryRecord, EventRecord } from '../lib/types';

const STATUS_VARIANTS: Record<DeliveryRecord['status'], 'default' | 'secondary' | 'destructive'> = {
  done: 'secondary',
  pending: 'default',
  failed: 'destructive',
};

export function Events() {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Events</h1>
        <p className="text-sm text-muted-foreground">
          Change events flowing through the bus — delivery health, dead letters, and a live feed.
        </p>
      </div>

      <Tabs defaultValue="deliveries">
        <TabsList>
          <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
          <TabsTrigger value="live">Live feed</TabsTrigger>
        </TabsList>
        <TabsContent value="deliveries">
          <DeliveriesTab />
        </TabsContent>
        <TabsContent value="live">
          <LiveFeedTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
Events.displayName = 'Events';

// --- Deliveries (ledger + DLQ) -------------------------------------------

function DeliveriesTab() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [dead, setDead] = useState(false);
  const [consumerInput, setConsumerInput] = useState('');
  const consumer = useDebounce(consumerInput, 300);

  const deliveries = useQuery({
    queryKey: ['event-deliveries', status, dead, consumer],
    queryFn: () =>
      api.listDeliveries({
        status: (status || undefined) as DeliveryRecord['status'] | undefined,
        dead: dead || undefined,
        consumer: consumer || undefined,
        limit: 100,
      }),
    refetchInterval: 10_000,
  });

  const retry = useMutation({
    mutationFn: (row: DeliveryRecord) => api.retryDelivery(row.eventId, row.consumer),
    onSuccess: () => {
      toast.success('Delivery queued for retry');
      void queryClient.invalidateQueries({ queryKey: ['event-deliveries'] });
    },
    onError: (error) =>
      toast.error(
        `Retry failed: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const rows = deliveries.data?.data ?? [];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delivery-status">Status</Label>
          <Select
            id="delivery-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-36"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="done">Done</option>
            <option value="failed">Failed</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delivery-consumer">Consumer</Label>
          <Input
            id="delivery-consumer"
            value={consumerInput}
            onChange={(e) => setConsumerInput(e.target.value)}
            placeholder="e.g. webhook:… or audit"
            className="w-56"
          />
        </div>
        <div className="mb-2 flex items-center gap-2 text-sm">
          <Switch id="dead-only" checked={dead} onCheckedChange={setDead} />
          <Label htmlFor="dead-only" className="font-normal">
            Dead letters only
          </Label>
        </div>
        <div className="ml-auto mb-2 text-xs text-muted-foreground">
          {deliveries.data ? `${deliveries.data.totalCount} total` : ''}
        </div>
      </div>

      {deliveries.isLoading ? (
        <Skeleton className="h-48 w-full" aria-hidden />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Radio className="h-8 w-8" />}
          title={dead ? 'No dead letters' : 'No deliveries'}
          hint={
            dead
              ? 'Nothing has exhausted its retry budget. Healthy!'
              : 'Deliveries appear once subscriptions (audit, webhooks, …) process events.'
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Topic
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Consumer
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Attempts
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.eventId}:${row.consumer}`}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs">{row.topic}</div>
                      {row.error && (
                        <div className="mt-0.5 max-w-md truncate text-xs text-[--ion-red]">
                          {row.error}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{row.consumer}</td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANTS[row.status]}>{row.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs">{row.attempts}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(row.processedAt ?? row.occurredAt), {
                        addSuffix: true,
                      })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {row.status === 'failed' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(row)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" /> Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
DeliveriesTab.displayName = 'DeliveriesTab';

// --- Live feed --------------------------------------------------------

const MAX_LIVE_EVENTS = 200;

function LiveFeedTab() {
  const [running, setRunning] = useState(true);
  const [topicsInput, setTopicsInput] = useState('data.#');
  const topics = useDebounce(topicsInput, 500);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!running || !topics.trim()) return;
    const source = new EventSource(
      `/api/v1/events/stream?topics=${encodeURIComponent(topics.trim())}`,
      { withCredentials: true },
    );
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as EventRecord;
      setEvents((prev) => [event, ...prev].slice(0, MAX_LIVE_EVENTS));
    };
    source.onerror = () => {
      // EventSource retries automatically; nothing to do.
    };
    return () => source.close();
  }, [running, topics]);

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="live-topics">Topic patterns</Label>
          <Input
            id="live-topics"
            value={topicsInput}
            onChange={(e) => setTopicsInput(e.target.value)}
            placeholder="data.#, data.contacts.*"
            className="w-72 font-mono text-xs"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mb-1 gap-1.5"
          onClick={() => setRunning((r) => !r)}
        >
          {running ? (
            <>
              <Pause className="h-3.5 w-3.5" /> Pause
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> Resume
            </>
          )}
        </Button>
        {events.length > 0 && (
          <Button variant="ghost" size="sm" className="mb-1" onClick={() => setEvents([])}>
            Clear
          </Button>
        )}
      </div>

      {events.length === 0 ? (
        <EmptyState
          icon={<Radio className="h-8 w-8" />}
          title={running ? 'Listening…' : 'Paused'}
          hint="Change a record anywhere (REST, GraphQL, MCP, the grid) and it appears here instantly."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/60">
              {events.map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-secondary/40"
                    onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                  >
                    <span className="font-mono text-xs">{event.topic}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {format(new Date(event.occurredAt), 'HH:mm:ss')}
                    </span>
                  </button>
                  {expanded === event.id && (
                    <pre className="max-h-64 overflow-auto border-t border-border/60 bg-surface-sunken px-4 py-3 font-mono text-xs">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
LiveFeedTab.displayName = 'LiveFeedTab';
