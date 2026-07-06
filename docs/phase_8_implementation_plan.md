# Phase 8: Admin Console UX Overhaul

> **Goal:** Transform the functional-but-utilitarian Ion Drive admin console into a premium, production-grade experience worthy of a flagship open source project. Inspired by **Airtable** (data grid & record editing), **Supabase** (table editor, clean dashboard), and **.NET Aspire** (telemetry dashboard, structured logs). Visual language follows the **Radix UI / shadcn** black-and-white aesthetic with strategic space-themed accent pops in strategic places. Re-think the design system from the ground up and ensure that the component and structure of the admin console is solid, maintainable, and scalable and worthy of a production-grade open source project -- this is not just a hobby project.

> [!IMPORTANT]
> This is an open source project. Every component, hook, and utility added in this phase must meet the same standards as the existing `packages/core` codebase: **top-of-file JSDoc**, **strict TypeScript**, **Biome-clean**, **tested**, and **documented**. The admin console is the first thing a user sees — it _is_ the product's first impression.

---

## Design Philosophy

| Principle                            | Concrete Requirement                                                                                 |
| :----------------------------------- | :--------------------------------------------------------------------------------------------------- |
| **Instantly at home**                | Keyboard-first navigation, familiar spreadsheet interactions, VS Code-like command palette           |
| **Massively productive**             | Inline editing, bulk operations, `⌘K` search, Tab/Enter/Escape/Arrow key grid navigation             |
| **Clean, not clinical**              | Black/white base with `--ion-blue` and `--ion-purple` accent pops — never garish                     |
| **The pulse is visible**             | Health, errors, and throughput are glanceable from every screen via the sidebar status and dashboard |
| **Space-themed, not space-costumed** | Subtle glow effects, star-field login background, cosmic nomenclature — never a cartoon rocket       |
| **Contributor-friendly**             | Every component is self-documented, consistently patterned, and independently testable               |

---

## Architectural Conventions

> These conventions extend the project-wide rules in [CLAUDE.md](file:///i:/jaredgrabill/ion-drive/CLAUDE.md) and [CONTRIBUTING.md](file:///i:/jaredgrabill/ion-drive/CONTRIBUTING.md). They apply to all code written in Phase 8.

### Component Anatomy

Every React component file follows this structure:

````tsx
/**
 * ComponentName — one-line description of purpose.
 *
 * Longer explanation of behavior, interaction model, and design decisions.
 * Reference the design system tokens it uses and any Radix primitives it wraps.
 *
 * @example
 * ```tsx
 * <ComponentName variant="outline" size="sm">Label</ComponentName>
 * ```
 */

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/utils';

// --- Types -----------------------------------------------------------

export interface ComponentNameProps extends ComponentPropsWithoutRef<'div'> {
  /** Prop description. */
  variant?: 'default' | 'outline';
}

// --- Component -------------------------------------------------------

export const ComponentName = forwardRef<HTMLDivElement, ComponentNameProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(/* ... */, className)}
        {...props}
      />
    );
  },
);
ComponentName.displayName = 'ComponentName';
````

**Rules:**

- `forwardRef` on every primitive that wraps a DOM element (buttons, inputs, panels)
- `displayName` set explicitly (React DevTools + error messages)
- Props interface exported and extends the appropriate HTML element's props
- `className` always last in `cn()` so callers can override
- Variants use `class-variance-authority` (already a dep)
- **No default exports** — named exports only, matching the existing codebase pattern

### File Organization

```
components/
├── ui/                      # Atomic primitives (button, input, badge, etc.)
│   ├── button.tsx           # One component per file
│   ├── input.tsx
│   ├── ...
│   └── index.ts             # Barrel — re-exports everything
├── layout/                  # App shell, sidebar, header, breadcrumbs
├── data/                    # DataGrid, RecordSheet, FilterBuilder, etc.
└── charts/                  # Recharts wrappers for dashboard
```

**Naming rules:**

- Files: `kebab-case.tsx` (e.g., `dropdown-menu.tsx`, `status-dot.tsx`)
- Components: `PascalCase` (e.g., `DropdownMenu`, `StatusDot`)
- Hooks: `use-kebab-case.ts` (e.g., `use-debounce.ts`)
- Stores: `kebab-case-store.ts` (e.g., `grid-store.ts`)
- One component per file (compound components — like `Tabs`/`TabsList`/`TabsContent` — stay in one file)

### Module Documentation

Every file gets a **top-of-file JSDoc block** (matching [CLAUDE.md](file:///i:/jaredgrabill/ion-drive/CLAUDE.md) conventions):

```tsx
/**
 * FilterBuilder — composable visual filter editor for the DataGrid toolbar.
 *
 * Renders an Add Filter popover that lets users compose field → operator →
 * value conditions. Conditions map 1:1 to the Ion Drive REST query operators
 * (`[eq]`, `[gt]`, `[contains]`, etc.) from Phase 7. Multiple filters compose
 * with AND; the active filter count is shown as a badge on the trigger button.
 *
 * Uses Radix Popover for positioning and the existing Tailwind design tokens
 * for styling. State is lifted to the parent via `onFilterChange(filters)`.
 */
```

### Accessibility (WCAG 2.1 AA)

This is a non-negotiable quality bar for an OSS admin tool:

| Requirement               | How                                                                                                                                         |
| :------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------ |
| **Keyboard navigation**   | Every interactive element reachable via Tab. Grids support Arrow keys. Modals trap focus. `Escape` closes overlays                          |
| **ARIA roles and labels** | Radix primitives provide these by default. Custom components must add `role`, `aria-label`, `aria-expanded`, `aria-selected` as appropriate |
| **Focus indicators**      | Visible focus ring (`focus-visible:ring-2 ring-ring`) on all interactive elements. Never `outline: none` without a visible replacement      |
| **Color contrast**        | All text meets 4.5:1 contrast ratio against its background. Status indicators use icon/shape _in addition to_ color                         |
| **Screen reader text**    | Icon-only buttons get `aria-label`. Status indicators get `sr-only` text. Empty states are announced                                        |
| **Motion sensitivity**    | Respect `prefers-reduced-motion`: disable `pulse-glow`, `shimmer`, and slide animations                                                     |

### Testing Strategy

```
packages/admin/
├── src/
│   ├── components/
│   │   ├── ui/
│   │   │   ├── button.tsx
│   │   │   └── button.test.tsx     ← Co-located test
│   │   ├── data/
│   │   │   ├── data-grid.tsx
│   │   │   └── data-grid.test.tsx
│   │   └── ...
│   └── ...
├── vitest.config.ts
└── vitest.setup.ts                  ← jsdom + Testing Library setup
```

**Testing rules:**

- **Unit tests** with `vitest` + `@testing-library/react` (add to devDeps)
- Test files co-located next to the source file: `component-name.test.tsx`
- **What to test:**
  - UI primitives: Renders correctly, variant classes applied, forwarded ref works, accessibility attributes present
  - Data components: Loading states, error states, empty states, user interactions (click, keyboard), API call triggers
  - Hooks: State transitions, cleanup
  - _Not_ pixel-perfect styling — that's what Biome + manual review are for
- **Target:** 80%+ coverage on new components. Every component must have _at least_ a smoke test (renders without throwing) and an accessibility check
- **Accessibility testing:** `vitest-axe` or `@axe-core/react` for automated a11y checks in tests

### Error Handling

- **Error boundaries:** Wrap each page in a React error boundary that shows a friendly "Something went wrong" card with a retry button. Never a blank screen
- **API errors:** All mutations surface errors via toast notifications (not inline `<p>` text hidden below a scroll fold). Include the server's error message
- **Loading states:** Every data-fetching component shows a `Skeleton` or `Spinner`. Never render stale data without an indicator

### Performance Budget

| Metric                       | Target                                      |
| :--------------------------- | :------------------------------------------ |
| Admin JS bundle (gzipped)    | < 200KB initial, code-split per route       |
| Largest Contentful Paint     | < 1.5s on localhost                         |
| DataGrid render (100 rows)   | < 100ms                                     |
| DataGrid render (1000+ rows) | Virtualized, no dropped frames              |
| Layout shift (CLS)           | 0 — Skeletons match final layout dimensions |

---

## Tier 0 — Foundations

> These must land before Tier 1 work begins. They establish the design system and backend data sources that everything else depends on.

---

### 0A: Design System Rebuild

#### [MODIFY] [index.css](file:///i:/jaredgrabill/ion-drive/packages/admin/src/index.css)

Expand the token vocabulary from the current minimal shadcn set:

**Color tokens** — add space-themed accents alongside the existing neutrals:

```css
/* --- Space-themed accent palette --- */
--ion-blue: 215 100% 60%; /* Primary accent — ion engine glow */
--ion-purple: 265 70% 60%; /* Secondary accent — nebula purple */
--ion-cyan: 185 80% 55%; /* Tertiary — data flow cyan */
--ion-green: 155 75% 45%; /* Success — orbit green */
--ion-amber: 35 95% 55%; /* Warning — solar amber */
--ion-red: 0 72% 51%; /* Error — supernova red */

/* --- Semantic status tokens (resolve to the above) --- */
--status-healthy: var(--ion-green);
--status-warning: var(--ion-amber);
--status-error: var(--ion-red);
--status-idle: var(--muted-foreground);

/* --- Surface layers (dark mode) --- */
--surface-elevated: 240 6% 8%; /* Popover, dropdown bg */
--surface-sunken: 240 6% 3%; /* Code blocks, grid bg */
```

**Typography** — standardize the scale and add monospace:

```css
--font-sans: "Inter", system-ui, -apple-system, sans-serif;
--font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
```

**Animation** — add shared timing tokens + keyframes:

```css
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
--duration-fast: 120ms;
--duration-normal: 200ms;
--duration-slow: 350ms;

@keyframes fade-in {
  from {
    opacity: 0;
  }
}
@keyframes slide-up {
  from {
    transform: translateY(4px);
    opacity: 0;
  }
}
@keyframes shimmer {
  from {
    background-position: -200% 0;
  }
  to {
    background-position: 200% 0;
  }
}
@keyframes pulse-glow {
  0%,
  100% {
    box-shadow: 0 0 0 0 hsla(var(--ion-blue) / 0.4);
  }
  50% {
    box-shadow: 0 0 8px 2px hsla(var(--ion-blue) / 0.2);
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

Wire all new tokens into `@theme inline` for Tailwind v4 utility generation.

---

### 0B: Component Architecture

#### [REFACTOR] Split `ui.tsx` → `components/ui/` directory

The current monolithic [ui.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/components/ui.tsx) (206 lines, 9 components) works for MVP but doesn't scale. Split into:

```
components/ui/
├── button.tsx           ← MOVE from ui.tsx (add forwardRef + displayName)
├── input.tsx            ← MOVE (add forwardRef + displayName)
├── textarea.tsx         ← MOVE (add forwardRef + displayName)
├── select.tsx           ← MOVE (add forwardRef + displayName)
├── label.tsx            ← MOVE (add forwardRef + displayName)
├── card.tsx             ← MOVE (Card, CardHeader, CardTitle, CardContent)
├── badge.tsx            ← MOVE (add info variant)
├── dialog.tsx           ← MOVE + ENHANCE (add AlertDialog variant)
├── spinner.tsx          ← MOVE
├── empty-state.tsx      ← MOVE (add icon slot, action button slot)
├── sheet.tsx            ← NEW: Slide-out panel (Radix Dialog, side positioning)
├── tabs.tsx             ← NEW: Radix Tabs (TabsRoot, TabsList, TabsTrigger, TabsContent)
├── dropdown-menu.tsx    ← NEW: Radix DropdownMenu
├── popover.tsx          ← NEW: Radix Popover
├── tooltip.tsx          ← NEW: Radix Tooltip
├── context-menu.tsx     ← NEW: Radix ContextMenu
├── switch.tsx           ← NEW: Radix Switch (replace raw checkboxes for on/off settings)
├── checkbox.tsx         ← NEW: Radix Checkbox (styled, supports indeterminate)
├── skeleton.tsx         ← NEW: Shimmer loading placeholder
├── avatar.tsx           ← NEW: Initials circle with fallback
├── status-dot.tsx       ← NEW: 8px animated dot (healthy/warning/error/idle)
├── separator.tsx        ← NEW: Horizontal/vertical divider
├── scroll-area.tsx      ← NEW: Radix ScrollArea (custom styled scrollbars)
├── kbd.tsx              ← NEW: Keyboard shortcut display (⌘K, Esc, etc.)
└── index.ts             ← Barrel: export * from './button'; etc.
```

> [!IMPORTANT]
> **Migration:** Update all existing import sites (`import { Button, ... } from '../components/ui'`) to import from `'../components/ui'` (same path, but now resolves to the barrel `index.ts`). This is a refactor, not a breaking change — the public API is identical.

**New dependency installs** (each is a tiny, focused package):

| Package                         | Purpose                                        | Approx Size |
| :------------------------------ | :--------------------------------------------- | :---------- |
| `@radix-ui/react-tabs`          | Headless accessible tabs                       | ~5KB        |
| `@radix-ui/react-dropdown-menu` | Headless dropdown menus                        | ~8KB        |
| `@radix-ui/react-popover`       | Positioned floating panels                     | ~6KB        |
| `@radix-ui/react-tooltip`       | Delay-show info hints                          | ~5KB        |
| `@radix-ui/react-context-menu`  | Right-click menus                              | ~6KB        |
| `@radix-ui/react-dialog`        | Sheet + AlertDialog base                       | ~6KB        |
| `@radix-ui/react-switch`        | Accessible toggle                              | ~3KB        |
| `@radix-ui/react-checkbox`      | Accessible checkbox                            | ~3KB        |
| `@radix-ui/react-scroll-area`   | Custom scrollbars                              | ~4KB        |
| `@radix-ui/react-separator`     | Semantic separator                             | ~2KB        |
| `@tanstack/react-virtual`       | Row virtualization for grid                    | ~5KB        |
| `cmdk`                          | Command palette engine (built on Radix Dialog) | ~8KB        |
| `sonner`                        | Toast notification stack                       | ~6KB        |
| `date-fns`                      | Date formatting (tree-shakeable)               | varies      |

> [!NOTE]
> `@tanstack/react-table`, `react-hook-form`, `@hookform/resolvers`, `zod`, `zustand`, and `recharts` are **already listed in `package.json`** but unused in the current codebase. Phase 8 puts them all to work.

**Dev dependency installs:**

| Package                       | Purpose                     |
| :---------------------------- | :-------------------------- |
| `@testing-library/react`      | Component testing           |
| `@testing-library/jest-dom`   | DOM matchers                |
| `@testing-library/user-event` | User interaction simulation |
| `jsdom`                       | DOM environment for vitest  |

---

### 0C: Shared Hooks Library

#### [NEW] `src/hooks/` directory

Extract and create reusable hooks:

```
hooks/
├── use-dark-mode.ts        ← EXTRACT from AppShell.tsx (localStorage + classList)
├── use-debounce.ts         ← NEW: Generic debounced value (for search inputs)
├── use-local-storage.ts    ← NEW: Type-safe localStorage with SSR safety
├── use-keyboard-shortcut.ts ← NEW: Register global key combos (⌘K, Escape, etc.)
├── use-health.ts           ← NEW: Poll /health every 30s, expose status
└── index.ts                ← Barrel
```

Each hook follows:

```tsx
/**
 * useDebounce — returns a debounced copy of the input value.
 *
 * Updates the returned value only after `delay` ms of inactivity on the
 * input. Useful for search inputs where we want to avoid firing API calls
 * on every keystroke.
 *
 * @param value - The rapidly-changing input value.
 * @param delay - Debounce delay in milliseconds (default 300).
 * @returns The debounced value.
 */
export function useDebounce<T>(value: T, delay = 300): T {
  /* ... */
}
```

---

### 0D: Backend Observability Surface

> The admin dashboard and observability pages need data that doesn't exist yet. These backend additions follow the existing route/plugin patterns established in Phases 5–7.

#### [NEW] `packages/core/src/telemetry/log-buffer.ts`

An in-memory circular buffer that captures structured log entries:

```typescript
/**
 * LogBuffer — circular in-memory buffer for structured log entries.
 *
 * Captures log entries from the pino logger (via the `log-bridge.ts` OTel
 * bridge or a direct pino transport) into a fixed-size ring buffer. Entries
 * are queryable by level, source, time range, and full-text search on the
 * message field.
 *
 * This gives the admin console an "instant logs" view without requiring an
 * external observability stack (Loki, Elasticsearch). The buffer is intentionally
 * ephemeral — it's for recent debugging, not long-term retention.
 *
 * Buffer size is configurable via `ION_LOG_BUFFER_SIZE` (default: 2000).
 */

export interface LogEntry {
  id: string;
  timestamp: string; // ISO 8601
  level: "error" | "warn" | "info" | "debug";
  message: string;
  source: string; // Module that emitted the log (e.g., 'data-routes')
  traceId?: string;
  spanId?: string;
  attributes: Record<string, unknown>;
}

export interface LogQuery {
  level?: LogEntry["level"];
  source?: string;
  search?: string; // Full-text match on message + attribute values
  since?: string; // ISO timestamp, entries after this
  limit?: number; // Default 100, max 500
  offset?: number;
}

export class LogBuffer {
  constructor(maxSize?: number);
  push(entry: Omit<LogEntry, "id">): void;
  query(params: LogQuery): { data: LogEntry[]; total: number };
  clear(): void;
  get size(): number;
}
```

#### [NEW] `packages/core/src/api/stats-routes.ts`

Fastify plugin for dashboard data (follows `registerXxxRoutes(services)` pattern):

| Endpoint                              | Purpose                          | Data Source                                        |
| :------------------------------------ | :------------------------------- | :------------------------------------------------- |
| `GET /api/v1/stats`                   | Platform snapshot (counts)       | Direct SQL queries on system tables                |
| `GET /api/v1/stats/traffic?period=7d` | Time-bucketed API traffic        | In-process Prometheus registry                     |
| `GET /api/v1/stats/errors?limit=10`   | Recent error responses           | LogBuffer (level=error \| warn with status >= 400) |
| `GET /api/v1/version`                 | Version + uptime + feature flags | `package.json` + `process.uptime()` + config       |

#### [NEW] `packages/core/src/api/log-routes.ts`

| Endpoint                  | Purpose                                                            |
| :------------------------ | :----------------------------------------------------------------- |
| `GET /api/v1/logs`        | Query the LogBuffer (params: level, source, search, limit, offset) |
| `GET /api/v1/logs/stream` | SSE (Server-Sent Events) stream for real-time log tailing          |

Both are RBAC-guarded under resource `logs` with `read` permission.

---

## Tier 1 — Core Surfaces

> The highest-impact changes. These can begin once Tier 0 foundations are in place.

---

### 1A: App Shell & Navigation Refresh

#### Current State ([AppShell.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/components/AppShell.tsx))

- Sidebar is a flat list, no visual grouping
- Header is mostly empty (wasted space for breadcrumbs, search, user info)
- No system status indicator
- Version footer is stale (`v0.1.0 · Phase 3`)
- No collapsible mode

#### Changes

##### [REWRITE] `components/layout/app-shell.tsx`

Composes the new `Sidebar` + `Header` + `<Outlet />`.

##### [NEW] `components/layout/sidebar.tsx`

```
┌──────────────────────────────────┐
│  ◆ ION DRIVE            [«]    │  ← Logo + collapse toggle
│                                  │
│  OVERVIEW                        │  ← Section label (10px, uppercase, muted, tracked)
│    ◻ Dashboard                   │
│                                  │
│  DATA                            │
│    ◻ Data Objects                │
│    ◻ Building Blocks             │  ← NEW: Wires to Phase 6 block-routes
│    ◻ Tasks                       │  ← NEW: Wires to Phase 5 task-routes
│                                  │
│  ACCESS                          │
│    ◻ Users                       │
│    ◻ Roles                       │
│    ◻ API Keys                    │  ← Split out of Settings
│    ◻ Secrets                     │
│                                  │
│  OBSERVE                         │  ← NEW section
│    ◻ Logs                        │  ← NEW page
│    ◻ Metrics                     │  ← NEW page
│                                  │
│  ─────────────────────────────── │
│  ◻ Settings                      │
│                                  │
│──────────────────────────────────│
│  ● System Healthy     v0.2.0    │  ← StatusDot + version from /version
└──────────────────────────────────┘
```

**Design details:**

- **Logo mark:** Replace `⚡` emoji with a small inline SVG — a stylized diamond/thruster shape rendered in `--ion-blue` with a CSS `box-shadow` glow. This is the product's visual identity
- **Nav groups:** Uppercase, 10px `font-mono`, `--muted-foreground`, 0.05em letter-spacing. Groups: `OVERVIEW`, `DATA`, `ACCESS`, `OBSERVE`
- **Active state:** Left 2px border in `--ion-blue` + `bg-secondary`. Current: only bg change
- **Hover:** `bg-accent` with `var(--duration-fast)` ease transition
- **Collapsible:** 48px icon-only mode toggled by chevron. Icon-only items show `Tooltip` on hover. State in `use-local-storage('ion-sidebar-collapsed')`
- **Status footer:** `StatusDot` (component from 0B) pulsing green/amber/red from `use-health` hook. Version from `GET /api/v1/version`

##### [NEW] `components/layout/header.tsx`

```
┌──────────────────────────────────────────────────────────────┐
│  Dashboard  ›  Overview              [⌘K Search…]  ☽  [JD] │
└──────────────────────────────────────────────────────────────┘
```

- **Breadcrumbs** (left): Auto-derived from current route. `Data Objects › contacts › Data`. Each segment is a clickable `Link`
- **Command palette trigger** (center-right): Pill button with `Kbd` showing `⌘K` / `Ctrl+K`
- **Theme toggle** (right): Icon button, `Moon`/`Sun`
- **User menu** (right): `Avatar` + `DropdownMenu` with email, theme, logout

##### [NEW] `components/layout/breadcrumbs.tsx`

Extracts route segments from TanStack Router's `useRouterState`, maps them to display labels, renders as a horizontal `›`-separated trail.

---

### 1B: Data Grid — Airtable-Grade Table Editor

> This is the highest-impact change. The current [DataGrid.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/components/DataGrid.tsx) is a basic `<table>` (298 lines, no inline editing, no sorting, no filtering, no virtualization). Replace it with a real spreadsheet-like editor.

#### Architecture

```
components/data/
├── data-grid.tsx            ← Main orchestrator (TanStack Table instance)
├── data-grid.test.tsx       ← Tests: renders, pagination, loading/empty states
├── grid-toolbar.tsx         ← Search, filter, sort, hide-fields, refresh, add-record
├── grid-toolbar.test.tsx
├── filter-builder.tsx       ← Popover: field → operator → value rows
├── sort-builder.tsx         ← Popover: field + direction, multi-column
├── column-header.tsx        ← Resizable, sortable, type-icon, context menu
├── grid-cell.tsx            ← Type-aware read-only cell renderer
├── grid-cell-editor.tsx     ← Type-aware inline edit component
├── bulk-actions.tsx         ← Bar that appears when rows are selected
└── grid-types.ts            ← Shared types and column definitions
```

**Libraries used:**

- `@tanstack/react-table` — Column definitions, sorting, filtering, selection, pagination state
- `@tanstack/react-virtual` — Virtualized row rendering for large datasets
- `zustand` — Grid-level ephemeral state (column visibility, column order, persisted per-object to localStorage)

##### Grid Toolbar

```
┌────────────────────────────────────────────────────────────────────────┐
│ 🔍 Search records...  │ ⊕ Filter (2) │ ↕ Sort │ 👁 Fields │ ⟳ │ + New │ ⋯ │
└────────────────────────────────────────────────────────────────────────┘
```

| Control     | Behavior                                                                                                                                                                                 |
| :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search**  | Debounced (300ms) `q=` param against API. Badge count when active                                                                                                                        |
| **Filter**  | Popover — field selector → operator dropdown → value input. Operators map to existing Phase 7 query params (`[eq]`, `[gt]`, `[contains]`, `[in]`, etc.). Badge shows active filter count |
| **Sort**    | Popover — field + asc/desc. Multi-column sort. Also togglable by clicking column headers                                                                                                 |
| **Fields**  | Checklist popover to toggle column visibility. Persisted per-object via `use-local-storage`                                                                                              |
| **Refresh** | Re-fetches current query (resets TanStack Query cache for this key)                                                                                                                      |
| **+ New**   | Opens RecordSheet in create mode (see 1C)                                                                                                                                                |
| **⋯ More**  | `DropdownMenu`: Export as CSV, Bulk delete selected, Copy API URL                                                                                                                        |

##### Column Headers

- **Resizable:** Drag handle between columns. Min width 80px. Widths persisted per-object
- **Sortable:** Click cycles asc → desc → none. Arrow indicator in header
- **Type icon** in header: `Aa` (text), `#` (number), `📅` (date), `☐` (bool), `{}` (json), `◉` (enum)
- **Right-click context menu:** Sort A→Z, Sort Z→A, Hide column, Pin to left

##### Cell Rendering by Type

| Column Type                   | Display                                         | Edit Mode                                      |
| :---------------------------- | :---------------------------------------------- | :--------------------------------------------- |
| `text`, `short_text`          | Truncated string                                | `Input`, auto-select-all on focus              |
| `long_text`, `rich_text`      | Truncated, expand icon                          | Sheet panel with `Textarea`                    |
| `integer`, `decimal`, `float` | Right-aligned, formatted number                 | `Input type="number"`                          |
| `currency`                    | Formatted with locale symbol                    | `Input type="number"`                          |
| `percentage`                  | `65%` with subtle mini-bar behind text          | `Input type="number"`                          |
| `rating`                      | ★★★☆☆ filled stars                              | Click-to-set star count                        |
| `boolean`                     | Styled `Checkbox` (Radix)                       | Toggle inline (single click)                   |
| `date`, `datetime`            | Formatted via `date-fns`                        | Date input (native picker or Popover calendar) |
| `enum`                        | Colored `Badge` pill                            | `Select` dropdown with enum values             |
| `uuid`                        | Truncated mono, copy-to-clipboard icon on hover | Read-only                                      |
| `json`                        | `{ }` icon + key count, preview on hover        | Sheet panel with `Textarea` (monospace)        |
| `email`                       | Blue linked text                                | `Input type="email"`                           |
| `url`                         | Linked text + external-link icon                | `Input type="url"`                             |

##### Keyboard Navigation

| Key                     | Action                                                        |
| :---------------------- | :------------------------------------------------------------ |
| `Enter` or double-click | Enter edit mode on focused cell                               |
| `Escape`                | Cancel edit, revert value, return focus to cell               |
| `Tab` / `Shift+Tab`     | Move focus right/left                                         |
| `Arrow keys`            | Move focus (when not editing)                                 |
| `Ctrl+S` / `⌘S`         | Save current edit (if auto-save is off)                       |
| `Delete` / `Backspace`  | Clear cell value (when focused, not editing)                  |
| `Space`                 | Toggle boolean cells; toggle row selection on checkbox column |

##### Saving Model

- **Optimistic update:** Cell value updates immediately in the UI
- **PATCH on blur/Enter:** Single-field PATCH to `api.updateRecord(objectName, id, { fieldName: value })`
- **Error rollback:** If PATCH fails, revert cell to previous value + show error toast
- **Dirty indicator:** Small `--ion-blue` dot in cell corner while save is in-flight

##### Pagination

- Bottom bar: `Showing 1–25 of 1,234 records` + page buttons
- Support `pageSize` of 25 / 50 / 100 (dropdown)
- Total count always displayed

##### Loading State

`Skeleton` grid: 8 rows of shimmer bars matching column widths. Same dimensions as real rows to prevent layout shift.

---

### 1C: Record Detail Sheet (CRM-Style Form)

> A slide-out panel for viewing/editing a single record. Inspired by Airtable's expanded record view and Supabase's row editor.

#### [NEW] `components/data/record-sheet.tsx`

- **Trigger:** Click a row in the DataGrid (or the edit pencil icon)
- **Appearance:** `Sheet` component (Radix Dialog variant) sliding from the right, 520px wide, over a dimmed backdrop
- **Sections:**
  1. **Header:** Object display name + record ID (mono, copyable). Close button
  2. **Title area:** First text field rendered large as a "record name." Optional subtitle from second text field
  3. **Fields:** Two-column layout — label (40%) + value/editor (60%). Each field is an inline-editable row. System fields (`id`, `created_at`, `updated_at`) shown at bottom, read-only, muted
  4. **Relationships:** If the object has relationships, show a collapsible section with mini-grids of related records. Click a related record to navigate to its sheet (breadcrumb trail)
  5. **Footer:** `[Delete Record]` (destructive, left) + `[Cancel] [Save]` (right)

**Field editors** reuse the same type-aware components from `grid-cell-editor.tsx`, but rendered at full width instead of cell-constrained.

**Form state:** `react-hook-form` + `zod` validation (both already in deps). Schema-driven — field definitions from the API are mapped to a dynamic zod schema.

---

### 1D: Dashboard — System Pulse

#### [REWRITE] [Dashboard.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/pages/Dashboard.tsx)

From 4 static stat cards + a list → a live operational overview.

**Layout (top to bottom):**

1. **System Status Banner**
   - Full-width card: `StatusDot` + "All Systems Operational" (or error message). Uptime from `GET /api/v1/version`. Background: subtle gradient using `--ion-green` (healthy) or `--ion-red` (error) at 5% opacity

2. **Stat Cards Row** (4 columns)
   - Data Objects, Users, API Requests (24h), Scheduled Tasks
   - Each card: large number + delta trend (`↑2 this week`)
   - Click navigates to the relevant page

3. **Charts Row** (2 columns)
   - **API Traffic** (left, 60% width): `recharts` `<AreaChart>` with stacked areas for REST / GraphQL / MCP. Time axis (7d default). Tooltip on hover
   - **Response Times** (right, 40% width): Horizontal bar chart showing p50 / p95 / p99 latencies with color coding (green → amber → red)

4. **Bottom Row** (2 columns)
   - **Recent Errors** (left): List of recent 4xx/5xx responses. Status badge + method + path + relative time. Click → navigates to Logs page with filter pre-applied. "[View all logs →]" link
   - **Recent Objects** (right): Compact object list with field count. Same content as current but denser. "[View all →]" link

5. **Building Blocks Row** (full width, conditional)
   - Only shown if blocks feature is enabled. Cards for each installed block (✅ status, version, object count). "[Manage blocks →]" link

**Data sources:** `GET /api/v1/stats`, `GET /api/v1/stats/traffic?period=7d`, `GET /api/v1/stats/errors?limit=5`, existing object/user/role/key queries.

**Chart components:**

```
components/charts/
├── area-chart.tsx          ← Thin recharts wrapper with Ion Drive styling
├── bar-chart.tsx           ← Horizontal bar chart (latency percentiles)
├── spark-line.tsx          ← Mini inline SVG chart for stat card hover
└── chart-tooltip.tsx       ← Shared styled tooltip for recharts
```

---

## Tier 2 — Completeness & Polish

> These can be built in parallel once Tier 1 is stable. They round out the feature set and replace all rough edges.

---

### 2A: Observability Pages

#### [NEW] `pages/logs.tsx` — Structured Log Viewer

Consumes `GET /api/v1/logs` and `GET /api/v1/logs/stream` (SSE).

**Layout:**

- **Toolbar:** Level dropdown (`All | Error | Warn | Info | Debug`), Source dropdown (populated from distinct sources), Search input (full-text), Live toggle button (`▶ Live` / `⏸ Paused`), Export button
- **Log table:** Timestamp, Level (colored badge), Source (mono), Message. Click row to expand
- **Expanded detail:** Slide-down panel below the row showing full structured attributes as a key-value table. Trace ID with copy button

**Behaviors:**

- **Live mode:** SSE stream → new entries animate in at top with `slide-up` animation + brief `--ion-blue` glow
- **Auto-scroll:** When live + scrolled to top, new entries keep view at top. Scrolling away shows "↓ Jump to latest" floating pill
- **Level colors:** Error rows have subtle red left border, warn amber, info blue, debug gray
- **Persistence:** Filter state persisted in URL search params (shareable deep links)

#### [NEW] `pages/metrics.tsx` — Operational Metrics

Lightweight chart dashboard consuming `GET /api/v1/stats/traffic` and `GET /api/v1/stats/metrics`.

**Charts (2×2 grid):**

1. Request rate over time (line chart)
2. Error rate over time (line chart, red)
3. Latency distribution (histogram or percentile bars)
4. Request breakdown by surface (donut or stacked bar: REST / GraphQL / MCP)

**Period selector:** 1h / 6h / 24h / 7d tabs.

---

### 2B: New Entity Pages

#### [NEW] `pages/tasks.tsx` — Task Management

Wires to the existing `GET/POST/PATCH/DELETE /api/v1/tasks` endpoints (Phase 5). Currently tasks are API-only.

**List view:** Table with Name, Type (badge), Schedule (cron expression + human-readable "Every 5 min"), Enabled toggle (`Switch`), Last run (relative time + status badge)

**Detail view** (click a task row or navigate to `/tasks/$id`):

- Config editor: JSON editor or key-value form for the task's `config`
- Run history: Table of recent runs (status, trigger, duration, started_at). Expandable for result JSON
- "▶ Run Now" button → `POST /api/v1/tasks/:id/run` → toast with result

#### [NEW] `pages/blocks.tsx` — Building Blocks

Wires to `GET/POST/DELETE /api/v1/blocks` (Phase 6).

**Layout:**

- **Installed blocks** section: Card grid. Each card shows block name, version, object count, install date. `DropdownMenu` with: View objects, Uninstall (with confirmation dialog including data-loss warning)
- **Available blocks** section (future, can be a placeholder): List of catalog blocks not yet installed. Install button → preview dialog (dry run) → confirm

---

### 2C: Object Detail Enhancement

#### [MODIFY] [ObjectDetail.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/pages/ObjectDetail.tsx)

Replace the current 2-tab layout (`data` | `fields`) with 5 tabs using the new `Tabs` component:

| Tab               | Content                                                                                                                                                                                           |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Data**          | The new DataGrid (1B)                                                                                                                                                                             |
| **Schema**        | Field table with inline-edit for display name + description. Drag-to-reorder sort_order. Add Field dialog (enhanced). Type icons                                                                  |
| **Relationships** | List of FK relationships (source → target, type badge). Add Relationship button. Click → navigate to target object                                                                                |
| **API**           | Auto-generated reference: REST endpoints (curl examples), GraphQL query template, MCP tool name. Pulled from OpenAPI spec via `GET /api/v1/openapi.json`. Read-only code blocks with copy buttons |
| **Settings**      | Object rename, description edit, danger zone (delete object with type-name-to-confirm)                                                                                                            |

**Header enhancement:**

```
◆ Contacts                                        [⋯ More]
contacts · 12 fields · 3 relationships · 1,234 records

[ Data ]  [ Schema ]  [ Relationships ]  [ API ]  [ Settings ]
```

- Object "icon": Colored circle with first letter (deterministic color from name hash)
- Stats line with field/relationship/record counts — all live from API
- `⋯ More` dropdown: Export schema as JSON, Copy REST base URL, View in GraphQL

---

### 2D: System-Wide Polish

#### [NEW] Command Palette (`⌘K`)

Global search + action palette, accessible from any page.

##### [NEW] `components/layout/command-palette.tsx`

Built on `cmdk` (which uses Radix Dialog internally):

**Sections:**

1. **Recent** — Last 5 visited pages (stored in `use-local-storage`)
2. **Pages** — All navigable pages (Dashboard, Objects, Users, etc.)
3. **Data Objects** — Search objects by name, navigate to detail
4. **Actions** — "Create new object", "Create new role", "Toggle dark mode", "Copy API base URL"
5. **Records** — Global record search (debounced API call with `q=` across all objects)

**Keyboard:** `⌘K` / `Ctrl+K` opens. Arrow keys navigate. Enter selects. Escape closes.

#### [NEW] Toast Notification System

Replace all `alert()` calls and inline error `<p>` elements with a proper toast stack.

##### [NEW] `components/ui/toast.tsx` — Wrapper around `sonner`

```tsx
import { Toaster, toast } from "sonner";
// Configured: position bottom-right, dark mode aware, Ion Drive styling
```

**Usage pattern:**

```tsx
toast.success("Record updated");
toast.error("Failed to save: constraint violation", { duration: Infinity });
toast("Record deleted", {
  action: { label: "Undo", onClick: () => undoDelete(id) },
});
```

**Replacement targets:**

- Record create/edit/delete success → `toast.success()`
- API errors in mutations → `toast.error()` with server message
- Copy-to-clipboard → `toast('Copied to clipboard')`

#### Confirmation Dialog Upgrade

Replace all 9 `confirm()` calls with the `AlertDialog` variant of `Dialog`:

```tsx
<AlertDialog
  open={confirmDelete}
  onClose={() => setConfirmDelete(false)}
  title="Delete Data Object"
  description={`This will permanently delete "${obj.displayName}" and all ${recordCount} records. This cannot be undone.`}
  confirmLabel="Delete"
  confirmVariant="destructive"
  onConfirm={() => deleteObject.mutate()}
/>
```

For high-stakes operations (delete object, uninstall block with data), add a **type-to-confirm** input: "Type the object name to confirm."

**Files with `confirm()` calls to replace:**

- [DataGrid.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/components/DataGrid.tsx) (line 90: delete record)
- [ObjectDetail.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/pages/ObjectDetail.tsx) (line 68: delete object, line 136: remove field)
- [Roles.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/pages/Roles.tsx) (line 67: delete role)
- [Secrets.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/pages/Secrets.tsx) (line 72: delete secret)
- [Settings.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/pages/Settings.tsx) (line 74: revoke API key)
- [Users.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/pages/Users.tsx) (line 63: remove role from user)

#### Login Page Refresh

#### [MODIFY] [Login.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/pages/Login.tsx)

- **Background:** Full-screen dark with a subtle CSS-only star-field effect (small radial-gradient dots scattered via CSS, no canvas or JS)
- **Card:** The Ion Drive logo mark (glowing SVG diamond) above the title. Glass-morphism card (`backdrop-blur`, slight transparency)
- **"First time?" flow:** Bigger heading: "Set up your Ion Drive." Welcoming tone, not clinical
- **Submit button:** Solid black with white text (Radix aesthetic). Hover: subtle scale(1.01) + elevated shadow
- **Footer:** "Powered by Ion Drive · Open Source" with a GitHub link icon

---

## Router Changes

#### [MODIFY] [router.tsx](file:///i:/jaredgrabill/ion-drive/packages/admin/src/router.tsx)

Add new routes:

```tsx
route('/tasks', Tasks),
createRoute({ getParentRoute: () => rootRoute, path: '/tasks/$id', component: TaskDetail }),
route('/blocks', Blocks),
route('/logs', Logs),
route('/metrics', Metrics),
```

---

## API Client Changes

#### [MODIFY] [api.ts](file:///i:/jaredgrabill/ion-drive/packages/admin/src/lib/api.ts)

Add methods for new endpoints:

```typescript
// --- Stats ---
stats: () => request<StatsSnapshot>('/stats'),
traffic: (period = '7d') => request<TrafficData>(`/stats/traffic?period=${period}`),
recentErrors: (limit = 10) => request<{ data: ErrorEntry[] }>(`/stats/errors?limit=${limit}`).then(r => r.data),
version: () => request<VersionInfo>('/version'),

// --- Logs ---
queryLogs: (params: LogQueryParams) => request<{ data: LogEntry[]; total: number }>(`/logs?${toSearchParams(params)}`),
// SSE stream handled separately in the Logs page via EventSource

// --- Tasks ---
listTasks: () => request<{ data: TaskDef[] }>('/tasks').then(r => r.data),
getTask: (id: string) => request<{ data: TaskWithRuns }>(`/tasks/${id}`).then(r => r.data),
createTask: (input: TaskInput) => request('/tasks', { method: 'POST', body: JSON.stringify(input) }),
updateTask: (id: string, patch: Partial<TaskInput>) => request(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
deleteTask: (id: string) => request(`/tasks/${id}`, { method: 'DELETE' }),
runTask: (id: string) => request(`/tasks/${id}/run`, { method: 'POST' }),
taskRuns: (id: string, limit = 50) => request<{ data: TaskRun[] }>(`/tasks/${id}/runs?limit=${limit}`).then(r => r.data),

// --- Blocks ---
listBlocks: () => request<{ data: InstalledBlock[] }>('/blocks').then(r => r.data),
getBlock: (name: string) => request<{ data: InstalledBlock }>(`/blocks/${name}`).then(r => r.data),
previewInstall: (manifest: unknown) => request('/blocks/preview', { method: 'POST', body: JSON.stringify({ manifest }) }),
installBlock: (manifest: unknown, opts?: { dryRun?: boolean }) => request(`/blocks/install${opts?.dryRun ? '?dryRun=true' : ''}`, { method: 'POST', body: JSON.stringify({ manifest }) }),
uninstallBlock: (name: string, dropData = false) => request(`/blocks/${name}?dropData=${dropData}`, { method: 'DELETE' }),
```

---

## Anti-Patterns (Do NOT Do)

These are explicitly forbidden in Phase 8 code:

| ❌ Anti-Pattern                                               | ✅ Correct Approach                                      |
| :------------------------------------------------------------ | :------------------------------------------------------- |
| `confirm('Delete?')`                                          | `AlertDialog` with styled confirmation                   |
| `alert('Error')`                                              | `toast.error(message)`                                   |
| Inline `<p className="text-destructive">` for mutation errors | Toast notification                                       |
| `style={{ }}` inline styles                                   | Tailwind classes only (or CSS custom properties)         |
| `// @ts-ignore` / `as any`                                    | Proper typing; `unknown` + narrowing if needed           |
| Default exports (`export default function`)                   | Named exports: `export function ComponentName`           |
| `console.log` for debugging                                   | Remove before commit; use `toast` or logger              |
| Raw `<input type="checkbox">`                                 | `Checkbox` or `Switch` component                         |
| Raw `<select>` without styling                                | `Select` component or `DropdownMenu`                     |
| Unnamed magic numbers                                         | CSS custom properties or named constants                 |
| Components without `displayName`                              | Always set `ComponentName.displayName = 'ComponentName'` |
| Missing `aria-label` on icon buttons                          | Always provide accessible label                          |

---

## Implementation Parallelism

Phase 8 can be parallelized across **4 agents** with clear dependency boundaries:

### Agent 1: Design System + App Shell (Tier 0A, 0B, 0C + Tier 1A)

1. Expand `index.css` (0A)
2. Split `ui.tsx` → `ui/` directory, add all new primitives (0B)
3. Create hooks library (0C)
4. Rebuild AppShell → Sidebar + Header + Breadcrumbs (1A)
5. Build Command Palette (2D)
6. Refresh Login page (2D)

**Depends on:** Nothing (starts immediately)
**Blocks:** Tier 1B (grid needs ui components), Tier 1D (dashboard needs charts)

### Agent 2: Data Grid + Record Sheet (Tier 1B + 1C + 2C)

1. Build DataGrid with TanStack Table (1B)
2. Build GridToolbar, FilterBuilder, SortBuilder
3. Build type-aware GridCell renderers and GridCellEditor
4. Build RecordSheet with react-hook-form (1C)
5. Build BulkActions bar
6. Enhance ObjectDetail with 5-tab layout (2C)

**Depends on:** Tier 0B (ui components must exist)

### Agent 3: Backend + Dashboard + Observability (Tier 0D + 1D + 2A)

1. Build LogBuffer, stats-routes, log-routes in `packages/core` (0D)
2. Build Dashboard with recharts (1D)
3. Build Logs page with SSE (2A)
4. Build Metrics page (2A)
5. Wire `use-health` hook to StatusDot in sidebar

**Depends on:** Tier 0A (design tokens), Tier 0B (ui components for charts page)

### Agent 4: New Pages + Polish (Tier 2B + 2D)

1. Build Tasks page + TaskDetail (2B)
2. Build Blocks page (2B)
3. Add Toast system and replace all `alert()`/`confirm()` calls (2D)
4. Update router.tsx with new routes
5. Update api.ts with all new endpoint methods
6. Update lib/types.ts with all new types
7. Write tests for new components
8. End-to-end polish pass

**Depends on:** Tier 0B (ui components), Tier 0D (backend endpoints for tasks/blocks already exist from Phase 5/6)

---

## Verification Plan

### Automated Tests

```bash
# All packages — typecheck + lint + test
pnpm typecheck
pnpm lint:fix
pnpm --filter @ion-drive/admin test           # New component tests
pnpm --filter @ion-drive/core test            # Core tests still pass (66 existing + new stats/logs)
pnpm --filter @ion-drive/admin build          # Production build succeeds
```

### Manual Verification Checklist

#### Design System

- [ ] All pages render correctly in dark mode and light mode
- [ ] No raw browser checkboxes, selects, or unstyled elements visible
- [ ] `prefers-reduced-motion` disables all animations
- [ ] Focus rings visible on every interactive element via keyboard Tab

#### Data Grid

- [ ] Renders 100+ records without layout shift (skeleton → data)
- [ ] Inline edit: click cell → type → Tab to next → value saves
- [ ] Keyboard: Arrow keys navigate, Enter edits, Escape cancels
- [ ] Filter: add a text filter → results narrow → remove filter → results restore
- [ ] Sort: click column header → rows reorder → click again → reverse
- [ ] Bulk select: checkbox column → select 3 rows → delete selected → toast confirms

#### Record Sheet

- [ ] Click a grid row → sheet slides in from right
- [ ] Edit a field → Save → sheet closes → grid reflects change
- [ ] Relationships section shows related records (if any)
- [ ] Escape closes sheet without saving

#### Dashboard

- [ ] Stat cards show correct counts (match Objects, Users pages)
- [ ] API traffic chart renders with data (or empty state if no traffic)
- [ ] Recent errors list shows actual recent errors (or "No recent errors" empty state)
- [ ] Status banner shows green/red based on `/health` response

#### Observability

- [ ] Logs page: entries appear, level filter works, search works
- [ ] Logs live mode: toggle on → new server activity appears without refresh
- [ ] Metrics page: charts render with data for selected period

#### New Pages

- [ ] Tasks: list shows tasks, click opens detail with run history
- [ ] Tasks: "Run Now" triggers a run, result appears in history
- [ ] Blocks: installed blocks shown, uninstall works with confirmation

#### Cross-Cutting

- [ ] `⌘K` opens command palette, search finds pages and objects
- [ ] Toasts appear on all CRUD operations (no `alert()` or `confirm()` anywhere)
- [ ] Sidebar collapses to icon-only mode, persists across refresh
- [ ] No console errors in any page flow
- [ ] No regressions on auth flow (login, signup, logout, session)
