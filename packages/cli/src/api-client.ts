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
    opts: { dryRun?: boolean; force?: boolean } = {},
  ): Promise<InstallReport> {
    const params = new URLSearchParams();
    if (opts.dryRun) params.set('dryRun', 'true');
    if (opts.force) params.set('force', 'true');
    const qs = params.toString() ? `?${params}` : '';
    return this.request('POST', `/api/v1/blocks/install${qs}`, { manifest });
  }

  uninstall(
    name: string,
    opts: { dropData?: boolean } = {},
  ): Promise<{ removedObjects: string[] }> {
    const qs = opts.dropData ? '?dropData=true' : '';
    return this.request('DELETE', `/api/v1/blocks/${encodeURIComponent(name)}${qs}`);
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
