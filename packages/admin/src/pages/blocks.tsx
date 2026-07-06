/**
 * Blocks — installed building blocks (Phase 6 `/api/v1/blocks`).
 *
 * Card grid of installed blocks: title, version, status badge, object
 * count, install date, and an overflow menu with "View objects" and
 * "Uninstall" (AlertDialog with a drop-data checkbox and type-to-confirm
 * when data would be lost — the server enforces the same guards). Catalog
 * install stays in the CLI (`ion-drive add crm`), which the empty state
 * points at.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { format } from 'date-fns';
import { Blocks as BlocksIcon, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Skeleton,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { InstalledBlock } from '../lib/types';

// --- Page --------------------------------------------------------------

export function Blocks() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const blocks = useQuery({ queryKey: ['blocks'], queryFn: () => api.listBlocks() });
  const [uninstalling, setUninstalling] = useState<InstalledBlock | null>(null);
  const [dropData, setDropData] = useState(false);

  const uninstall = useMutation({
    mutationFn: ({ name, drop }: { name: string; drop: boolean }) => api.uninstallBlock(name, drop),
    onSuccess: (_data, vars) => {
      toast.success(`Uninstalled ${vars.name}`);
      void queryClient.invalidateQueries({ queryKey: ['blocks'] });
      void queryClient.invalidateQueries({ queryKey: ['objects'] });
    },
    onError: (error) =>
      toast.error(
        `Failed to uninstall: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Building Blocks</h1>
        <p className="text-sm text-muted-foreground">
          Pre-built domain modules — objects, tasks, roles, and subscriptions installed as a unit.
        </p>
      </div>

      {blocks.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (blocks.data ?? []).length === 0 ? (
        <EmptyState
          icon={<BlocksIcon className="h-8 w-8" />}
          title="No blocks installed"
          hint="Install one from the official catalog with the CLI: ion-drive add crm"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(blocks.data ?? []).map((block) => (
            <Card key={block.name}>
              <CardContent className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <BlocksIcon className="h-5 w-5 text-ion-purple" aria-hidden />
                    <h3 className="font-semibold">{block.title}</h3>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${block.title}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void navigate({ to: '/objects' })}>
                        View objects
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        destructive
                        onSelect={() => {
                          setDropData(false);
                          setUninstalling(block);
                        }}
                      >
                        Uninstall
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {block.name} · v{block.version}
                </p>
                {typeof block.manifest.description === 'string' && (
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {block.manifest.description}
                  </p>
                )}
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={block.status === 'installed' ? 'success' : 'warning'}>
                    {block.status}
                  </Badge>
                  <span>{block.createdObjects.length} objects</span>
                  <span className="ml-auto">
                    {format(new Date(block.installedAt), 'MMM d, yyyy')}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog
        open={uninstalling !== null}
        onClose={() => setUninstalling(null)}
        title={`Uninstall ${uninstalling?.title ?? ''}`}
        description={
          dropData
            ? `This removes the block AND permanently drops its ${uninstalling?.createdObjects.length ?? 0} objects with all their data. This cannot be undone.`
            : 'This removes the block registration and its tasks/subscriptions. Its data objects and records are kept.'
        }
        confirmLabel="Uninstall"
        confirmVariant="destructive"
        requireText={dropData ? (uninstalling?.name ?? '') : undefined}
        onConfirm={() => {
          if (uninstalling) uninstall.mutate({ name: uninstalling.name, drop: dropData });
        }}
      >
        {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (renders a button role=checkbox) */}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={dropData}
            onCheckedChange={(v) => setDropData(v === true)}
            aria-label="Also drop data"
          />
          Also drop this block's objects and data
        </label>
      </AlertDialog>
    </div>
  );
}
Blocks.displayName = 'Blocks';
