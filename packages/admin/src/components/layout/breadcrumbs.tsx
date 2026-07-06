/**
 * Breadcrumbs — route-derived navigation trail for the header.
 *
 * Extracts path segments from TanStack Router's location, maps known
 * segments to display labels, and renders a `›`-separated trail where every
 * segment except the last is a clickable Link. Dynamic segments (object
 * names, task ids) are shown verbatim.
 */

import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';

// --- Label map -------------------------------------------------------

const SEGMENT_LABELS: Record<string, string> = {
  objects: 'Data Objects',
  blocks: 'Building Blocks',
  tasks: 'Tasks',
  users: 'Users',
  roles: 'Roles',
  'api-keys': 'API Keys',
  secrets: 'Secrets',
  logs: 'Logs',
  metrics: 'Metrics',
  settings: 'Settings',
};

// --- Component -------------------------------------------------------

export function Breadcrumbs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const segments = pathname.split('/').filter(Boolean);

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      <Link
        to="/"
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      >
        {segments.length === 0 ? (
          <span className="font-medium text-foreground">Dashboard</span>
        ) : (
          'Dashboard'
        )}
      </Link>
      {segments.map((segment, index) => {
        const href = `/${segments.slice(0, index + 1).join('/')}`;
        const label = SEGMENT_LABELS[segment] ?? segment;
        const isLast = index === segments.length - 1;
        return (
          <Fragment key={href}>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
            {isLast ? (
              <span className="truncate font-medium text-foreground" aria-current="page">
                {label}
              </span>
            ) : (
              <Link
                to={href}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                {label}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
Breadcrumbs.displayName = 'Breadcrumbs';
