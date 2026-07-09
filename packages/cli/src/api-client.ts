/**
 * HTTP client for a running Ion Drive server's block surface (`/api/v1/blocks`).
 *
 * The CLI is a thin driver: it resolves manifests locally, then POSTs them here
 * for the server to validate and apply. Auth is via an optional API key
 * (`X-API-Key: iond_…`). Errors from the server's typed envelope
 * (`{ error, message, warnings }`) are surfaced as {@link ApiError}.
 */

import type { Manifest } from './registry/registry-client.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly warnings: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The structural old→new manifest delta computed by the server's upgrade
 * mode (spec-07). Wire mirror of core's `ManifestDelta` — re-declared here
 * because the CLI has no runtime core dependency; it reaches the CLI inside
 * the dry-run upgrade report (`report.delta`).
 */
export interface ManifestDeltaWire {
  from: string;
  to: string;
  objects: { added: string[]; removed: string[] };
  fields: {
    objectName: string;
    fieldName: string;
    kind: 'additive' | 'modifying' | 'destructive';
    changedKeys?: string[];
    presentationOnly?: boolean;
  }[];
  relationships: { added: string[]; removed: string[] };
  tasks: { name: string; kind: 'additive' | 'modifying' | 'destructive' }[];
  roles: { name: string; kind: 'additive' | 'modifying' | 'destructive' }[];
  subscriptions: { added: string[]; removed: string[]; changed: string[] };
  webhooks: { added: string[]; removed: string[]; changed: string[] };
  actions: { added: string[]; removed: string[] };
  hooks: { added: string[]; removed: string[] };
  seedChanged: boolean;
  code: { added: string[]; removed: string[]; changed: string[] };
  hasChanges: boolean;
}

/** One schema-engine preview from an upgrade dry run (spec-07). */
export interface UpgradePreviewWire {
  target: string;
  sqlStatements: string[];
  warnings: string[];
  errors: string[];
}

/** Report shape returned by install/preview (subset of the server's report). */
export interface InstallReport {
  block: string;
  version: string;
  dryRun: boolean;
  objectsCreated: string[];
  objectsSkipped: string[];
  relationshipsCreated: string[];
  recordsSeeded: Record<string, number>;
  tasksCreated: string[];
  rolesCreated: string[];
  rolesSkipped: string[];
  /** Actions/hooks exposed by the block (Phase 14; absent on older servers). */
  actionsExposed?: string[];
  hooksExposed?: string[];
  /** Bus subscriptions registered (Phase 9; absent on older servers). */
  subscriptionsRegistered?: string[];
  /**
   * Outbound webhooks provisioned, `name → once-only signing secret`
   * (Phase 12; absent on older servers).
   */
  webhooksCreated?: Record<string, string>;
  webhooksSkipped?: string[];
  // --- Upgrade-mode fields (spec-07; absent on plain installs/old servers) ---
  upgraded?: { from: string; to: string };
  released?: string[];
  skippedDestructive?: string[];
  tasksUpdated?: string[];
  tasksRemoved?: string[];
  webhooksUpdated?: string[];
  webhooksRemoved?: string[];
  delta?: ManifestDeltaWire;
  previews?: UpgradePreviewWire[];
  warnings: string[];
}

/** Registered action/hook handlers reported by `GET /api/v1/blocks/actions`. */
export interface RegisteredHandlers {
  actions: { block: string; name: string; description?: string }[];
  hooks: { block: string; name: string; description?: string }[];
}

export interface InstalledBlock {
  name: string;
  version: string;
  title: string;
  status: string;
  createdObjects: string[];
  installedAt: string;
  /**
   * The full manifest snapshot as installed — the pristine baseline
   * `ion-drive diff`/`update` compare code and schema against (spec-07).
   */
  manifest?: Manifest;
  /** Provenance columns (spec-04) — absent on pre-spec-04 servers. */
  artifactDigest?: string | null;
  sourceRegistry?: string | null;
  sourceUrl?: string | null;
  publisher?: string | null;
  attested?: boolean | null;
  trustTier?: string | null;
}

/**
 * Client-asserted install provenance, POSTed alongside the manifest and
 * stored in the server's `_ion_blocks` ledger (spec-04 §4). Audit metadata,
 * not a server-side security control.
 */
export interface InstallSource {
  registry?: string;
  url?: string;
  digest?: string;
  attested?: boolean;
  publisher?: string;
  tier?: 'official' | 'verified' | 'community';
}

export class IonApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  /** Auth headers only; content-type is added per-request when a body is sent. */
  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (withBody) h['content-type'] = 'application/json';
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(
        `Cannot reach Ion Drive at ${this.baseUrl} — is the server running? (${(err as Error).message})`,
        0,
      );
    }

    if (res.status === 204) return undefined as T;
    const payload = (await res.json().catch(() => ({}))) as {
      data?: T;
      error?: string;
      message?: string;
      warnings?: string[];
    };
    if (!res.ok) {
      throw new ApiError(
        payload.message || payload.error || `Request failed (${res.status})`,
        res.status,
        payload.warnings ?? [],
      );
    }
    return payload.data as T;
  }

  /**
   * Verifies connectivity and returns the server's health payload. `/health` is
   * a bare (non-`{data}`-wrapped) response, so it is fetched directly rather
   * than through {@link request}.
   */
  async health(): Promise<{ status: string; version: string; objectCount: number }> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/health`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers(false) });
    } catch (err) {
      throw new ApiError(
        `Cannot reach Ion Drive at ${this.baseUrl} — is the server running? (${(err as Error).message})`,
        0,
      );
    }
    if (!res.ok) throw new ApiError(`Health check failed (${res.status})`, res.status);
    return (await res.json()) as { status: string; version: string; objectCount: number };
  }

  listInstalled(): Promise<InstalledBlock[]> {
    return this.request('GET', '/api/v1/blocks');
  }

  /** One installed block's ledger row (incl. provenance — spec-04). */
  getBlock(name: string): Promise<InstalledBlock> {
    return this.request('GET', `/api/v1/blocks/${encodeURIComponent(name)}`);
  }

  /** The action/hook handlers currently registered in the running server (Phase 14). */
  async listRegisteredHandlers(): Promise<RegisteredHandlers> {
    const data = await this.request<{ registered: RegisteredHandlers }>(
      'GET',
      '/api/v1/blocks/actions',
    );
    return data.registered;
  }

  install(
    manifest: Manifest,
    opts: {
      dryRun?: boolean;
      force?: boolean;
      /** Spec-07 upgrade mode — the block must be installed at a lower version. */
      upgrade?: boolean;
      /** With upgrade+force: drop removed objects even when they hold rows. */
      dropData?: boolean;
      source?: InstallSource;
    } = {},
  ): Promise<InstallReport> {
    const params = new URLSearchParams();
    if (opts.dryRun) params.set('dryRun', 'true');
    if (opts.force) params.set('force', 'true');
    if (opts.upgrade) params.set('upgrade', 'true');
    if (opts.dropData) params.set('dropData', 'true');
    const qs = params.toString() ? `?${params}` : '';
    return this.request('POST', `/api/v1/blocks/install${qs}`, {
      manifest,
      ...(opts.source ? { source: opts.source } : {}),
    });
  }

  uninstall(
    name: string,
    opts: { dropData?: boolean } = {},
  ): Promise<{ removedObjects: string[] }> {
    const qs = opts.dropData ? '?dropData=true' : '';
    return this.request('DELETE', `/api/v1/blocks/${encodeURIComponent(name)}${qs}`);
  }

  // --- Data + action surface (used by `ion-drive block test`, spec-06) ---

  /**
   * Lists an object's records. Fetched raw (not through {@link request})
   * because the data envelope carries `pagination` beside `data` and the
   * generic unwrap would drop the total count.
   */
  async listData(object: string): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1/data/${encodeURIComponent(object)}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers(false) });
    } catch (err) {
      throw new ApiError(
        `Cannot reach Ion Drive at ${this.baseUrl} — is the server running? (${(err as Error).message})`,
        0,
      );
    }
    const payload = (await res.json().catch(() => ({}))) as {
      data?: Record<string, unknown>[];
      pagination?: { totalCount?: number };
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      throw new ApiError(
        payload.message || payload.error || `Request failed (${res.status})`,
        res.status,
      );
    }
    const rows = payload.data ?? [];
    return { rows, totalCount: payload.pagination?.totalCount ?? rows.length };
  }

  /**
   * Invokes a block action, returning the raw status + parsed body instead of
   * throwing on non-2xx — `block test` classifies 400s ("wired, input
   * rejected") differently from 404s ("not wired") and 5xx ("handler blew up").
   * Only a network failure throws.
   */
  async invokeAction(
    block: string,
    action: string,
    input: Record<string, unknown>,
  ): Promise<{ status: number; message?: string }> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1/blocks/${encodeURIComponent(
      block,
    )}/actions/${encodeURIComponent(action)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(input),
      });
    } catch (err) {
      throw new ApiError(
        `Cannot reach Ion Drive at ${this.baseUrl} — is the server running? (${(err as Error).message})`,
        0,
      );
    }
    const payload = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    return { status: res.status, message: payload.message ?? payload.error };
  }

  // --- Schema snapshot & drift doctor (Phase 10) ---

  /** Full declarative schema snapshot from the server. */
  pullSnapshot(): Promise<SchemaSnapshotWire> {
    return this.request('GET', '/api/v1/schema/snapshot');
  }

  /** Diffs a snapshot against the server without applying (dryRun). */
  diffSnapshot(
    snapshot: SchemaSnapshotWire,
    opts: { prune?: boolean } = {},
  ): Promise<{ changes: SnapshotChange[]; changeCount: number }> {
    const params = new URLSearchParams({ dryRun: 'true' });
    if (opts.prune) params.set('prune', 'true');
    return this.request('POST', `/api/v1/schema/snapshot?${params}`, snapshot);
  }

  /** Applies a snapshot to the server through the validated schema pipeline. */
  pushSnapshot(
    snapshot: SchemaSnapshotWire,
    opts: { prune?: boolean; force?: boolean } = {},
  ): Promise<{ results: SnapshotApplyOutcome[]; applied: number; failed: number }> {
    const params = new URLSearchParams();
    if (opts.prune) params.set('prune', 'true');
    if (opts.force) params.set('force', 'true');
    const qs = params.toString() ? `?${params}` : '';
    return this.request('POST', `/api/v1/schema/snapshot${qs}`, snapshot);
  }

  /** Runs the schema drift doctor. */
  doctor(): Promise<DoctorReportWire> {
    return this.request('GET', '/api/v1/schema/doctor');
  }

  /** Adopts an unmanaged table/column into metadata. */
  adopt(table: string, column?: string): Promise<unknown> {
    return this.request('POST', '/api/v1/schema/doctor/adopt', { table, column });
  }

  /** Silences a doctor finding via the persisted allowlist. */
  ignoreFinding(key: string): Promise<unknown> {
    return this.request('POST', '/api/v1/schema/doctor/ignore', { key });
  }
}

// --- Wire types for the Phase 10 schema surface ---

/** Opaque snapshot payload — the CLI round-trips it without interpreting. */
export type SchemaSnapshotWire = Record<string, unknown> & {
  formatVersion: number;
  objects: unknown[];
  relationships: unknown[];
};

export interface SnapshotChange {
  kind: string;
  objectName: string;
  fieldName?: string;
  relationshipName?: string;
  summary: string;
}

export interface SnapshotApplyOutcome {
  entry: SnapshotChange;
  success: boolean;
  errors: string[];
  warnings: string[];
}

export interface DoctorFindingWire {
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  table: string;
  column?: string;
  objectName?: string;
  detail: string;
  suggestedType?: string;
  ignoreKey: string;
}

export interface DoctorReportWire {
  healthy: boolean;
  findings: DoctorFindingWire[];
  ignored: string[];
  checkedAt: string;
}
