/**
 * SchemaHealthCard — the drift doctor's face in Settings (Phase 10 / 4B).
 *
 * Runs `GET /schema/doctor` and lists findings: unmanaged tables/columns
 * (with one-click **Adopt** into metadata), type mismatches, and missing
 * tables/columns. Every finding can be **Ignored** (persisted allowlist).
 * Block-owned drift arrives pre-escalated to `critical` from the server.
 * Report-only by design — nothing here touches the database schema.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Stethoscope } from 'lucide-react';
import { ApiError, api } from '../../lib/api';
import type { DoctorFinding } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Badge, Button, Card, CardContent, Skeleton, StatusDot, toast } from '../ui';

const SEVERITY_TONE: Record<DoctorFinding['severity'], 'healthy' | 'warning' | 'error'> = {
  info: 'healthy',
  warning: 'warning',
  critical: 'error',
};

export function SchemaHealthCard() {
  const queryClient = useQueryClient();
  const report = useQuery({ queryKey: ['schema-doctor'], queryFn: () => api.schemaDoctor() });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['schema-doctor'] });

  const adopt = useMutation({
    mutationFn: (finding: DoctorFinding) => api.doctorAdopt(finding.table, finding.column),
    onSuccess: () => {
      toast.success('Adopted into managed metadata');
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['objects'] });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Adopt failed unexpectedly'),
  });

  const ignore = useMutation({
    mutationFn: (key: string) => api.doctorIgnore(key),
    onSuccess: () => {
      toast('Finding ignored');
      refresh();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Ignore failed unexpectedly'),
  });

  return (
    <Card>
      <CardContent>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 className="font-semibold">Schema health</h2>
            {report.data && (
              <StatusDot
                status={report.data.healthy ? 'healthy' : 'error'}
                label={
                  report.data.healthy ? 'No drift' : `${report.data.findings.length} finding(s)`
                }
              />
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Re-run schema doctor"
            onClick={refresh}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        {report.isLoading && <Skeleton className="h-16 w-full" />}
        {report.isError && (
          <p className="text-sm text-muted-foreground">
            Doctor unavailable — {report.error instanceof ApiError ? report.error.message : 'error'}
          </p>
        )}

        {report.data?.healthy && (
          <p className="text-sm text-muted-foreground">
            The database and Ion Drive metadata agree.
            {report.data.ignored.length > 0 &&
              ` (${report.data.ignored.length} finding(s) on the ignore list.)`}
          </p>
        )}

        {report.data && !report.data.healthy && (
          <ul className="flex flex-col gap-2">
            {report.data.findings.map((finding) => (
              <li
                key={`${finding.kind}:${finding.ignoreKey}`}
                className={cn(
                  'flex flex-col gap-1.5 rounded-md border p-3',
                  finding.severity === 'critical'
                    ? 'border-destructive/40 bg-destructive/5'
                    : 'border-ion-amber/30 bg-ion-amber/5',
                )}
              >
                <div className="flex items-center gap-2">
                  <StatusDot status={SEVERITY_TONE[finding.severity]} />
                  <span className="font-mono text-sm font-medium">
                    {finding.table}
                    {finding.column ? `.${finding.column}` : ''}
                  </span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {finding.kind.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{finding.detail}</p>
                <div className="flex gap-2">
                  {(finding.kind === 'unmanaged_table' || finding.kind === 'unmanaged_column') && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={adopt.isPending}
                      onClick={() => adopt.mutate(finding)}
                    >
                      Adopt{finding.suggestedType ? ` as ${finding.suggestedType}` : ''}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={ignore.isPending}
                    onClick={() => ignore.mutate(finding.ignoreKey)}
                  >
                    Ignore
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
SchemaHealthCard.displayName = 'SchemaHealthCard';
