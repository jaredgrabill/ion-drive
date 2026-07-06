/**
 * Sidebar — grouped navigation rail with collapse mode and status footer.
 *
 * Nav items are organized into OVERVIEW / DATA / ACCESS / OBSERVE groups
 * (10px uppercase mono labels). The active item gets a soft secondary fill
 * and its icon "ionizes" — ion-blue with a faint glow (the accent lives in
 * the icon, not an edge border). A chevron collapses the rail to a 48px
 * icon-only mode (persisted via `use-local-storage`; icons then get
 * tooltips). The footer shows a pulsing StatusDot from `use-health` plus the
 * server version from `GET /api/v1/version`.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Blocks,
  CalendarClock,
  Database,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  Shield,
  Users,
} from 'lucide-react';
import { useHealth, useLocalStorage } from '../../hooks';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button, SimpleTooltip, StatusDot, type SystemStatus } from '../ui';
import { LogoMark } from './logo';

// --- Navigation model ------------------------------------------------

interface NavItem {
  to: string;
  label: string;
  icon: typeof Database;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Data',
    items: [
      { to: '/objects', label: 'Data Objects', icon: Database },
      { to: '/blocks', label: 'Building Blocks', icon: Blocks },
      { to: '/tasks', label: 'Tasks', icon: CalendarClock },
    ],
  },
  {
    label: 'Access',
    items: [
      { to: '/users', label: 'Users', icon: Users },
      { to: '/roles', label: 'Roles', icon: Shield },
      { to: '/api-keys', label: 'API Keys', icon: KeyRound },
      { to: '/secrets', label: 'Secrets', icon: LockKeyhole },
    ],
  },
  {
    label: 'Observe',
    items: [
      { to: '/logs', label: 'Logs', icon: ScrollText },
      { to: '/metrics', label: 'Metrics', icon: Activity },
    ],
  },
];

const STATUS_LABELS: Record<SystemStatus, string> = {
  healthy: 'System Healthy',
  warning: 'Degraded',
  error: 'System Error',
  idle: 'Checking…',
};

// --- Nav link --------------------------------------------------------

function NavLink({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const link = (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-[var(--duration-fast)]',
        active
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <item.icon
        className={cn(
          'h-4 w-4 shrink-0',
          active && 'text-ion-blue drop-shadow-[0_0_5px_hsl(var(--ion-blue)/0.55)]',
        )}
        aria-hidden
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {collapsed && <span className="sr-only">{item.label}</span>}
    </Link>
  );
  return collapsed ? (
    <SimpleTooltip label={item.label} side="right">
      {link}
    </SimpleTooltip>
  ) : (
    link
  );
}

// --- Component -------------------------------------------------------

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, setCollapsed] = useLocalStorage('ion-sidebar-collapsed', false);
  const { status } = useHealth();
  const version = useQuery({
    queryKey: ['version'],
    queryFn: () => api.version(),
    staleTime: 5 * 60_000,
  });

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <aside
      className={cn(
        'flex flex-col border-r border-border bg-card transition-[width] duration-[var(--duration-normal)]',
        collapsed ? 'w-14' : 'w-60',
      )}
    >
      {/* Logo + collapse toggle */}
      <div
        className={cn(
          'flex h-14 items-center gap-2 border-b border-border px-3',
          collapsed && 'justify-center px-0',
        )}
      >
        <Link to="/" className="flex items-center gap-2 font-semibold" aria-label="Ion Drive home">
          <LogoMark size={22} />
          {!collapsed && <span className="tracking-tight">Ion Drive</span>}
        </Link>
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground"
            aria-label="Collapse sidebar"
            onClick={() => setCollapsed(true)}
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Grouped nav */}
      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2" aria-label="Primary">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            {!collapsed && (
              <p className="px-2.5 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
                {group.label}
              </p>
            )}
            {group.items.map((item) => (
              <NavLink key={item.to} item={item} active={isActive(item.to)} collapsed={collapsed} />
            ))}
          </div>
        ))}
      </nav>

      {/* Settings + expand toggle */}
      <div className="flex flex-col gap-0.5 border-t border-border p-2">
        <NavLink
          item={{ to: '/settings', label: 'Settings', icon: Settings }}
          active={isActive('/settings')}
          collapsed={collapsed}
        />
        {collapsed && (
          <SimpleTooltip label="Expand sidebar" side="right">
            <Button
              variant="ghost"
              size="icon-sm"
              className="mx-auto text-muted-foreground"
              aria-label="Expand sidebar"
              onClick={() => setCollapsed(false)}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
        )}
      </div>

      {/* Status footer */}
      <div
        className={cn(
          'flex h-10 items-center gap-2 border-t border-border px-3 text-xs text-muted-foreground',
          collapsed && 'justify-center px-0',
        )}
      >
        <StatusDot status={status} pulse={status === 'healthy'} label={STATUS_LABELS[status]} />
        {!collapsed && (
          <>
            <span className="truncate">{STATUS_LABELS[status]}</span>
            {version.data && <span className="ml-auto font-mono">v{version.data.version}</span>}
          </>
        )}
      </div>
    </aside>
  );
}
Sidebar.displayName = 'Sidebar';
