/**
 * Building-block manifest types + runtime validation (Phase 6).
 *
 * A **building block** is a self-contained bundle of business-domain
 * schema (data objects + relationships), optional seed data, scheduled tasks,
 * and RBAC roles — distributed shadcn-style (the consumer owns a copy of the
 * manifest and can freely edit it). See ADR-013 and ADR-006.
 *
 * The canonical shape is described here as a Zod schema ({@link blockManifestSchema})
 * so that *any* submitted manifest — bundled, local file, or remote registry — is
 * validated the same way before the installer touches the database. The parsed
 * result ({@link BlockManifest}) is deliberately structural: it reuses the schema
 * engine's {@link DataObjectDefinition}/{@link RelationshipDefinition} shapes and
 * the task engine's {@link TaskInput}, so a block installs through the exact same
 * code paths a human uses via the admin console.
 */

import semver from 'semver';
import { z } from 'zod';
import { ACTIONS } from '../auth/rbac/policy-types.js';
import type { Subscription } from '../messaging/event-types.js';
import { COLUMN_TYPES } from '../schema/types.js';
import type {
  DataObjectDefinition,
  FieldDefinition,
  RelationshipDefinition,
} from '../schema/types.js';
import type { TaskInput } from '../tasks/index.js';
// Type-only import — erased at runtime, so the module cycle with
// manifest-diff.ts (which imports BlockManifest from here) is harmless.
import type { ManifestDelta } from './manifest-diff.js';

// ---------------------------------------------------------------------------
// Shared name / version / range grammar (ADR-022 / spec-02)
// ---------------------------------------------------------------------------

/**
 * The block `name` grammar — bare, namespace-free, lowercase kebab/snake case.
 * The ledger and `/blocks/<name>` paths key on this; the registry protocol
 * (`registry-types.ts`) uses it for its record keys too.
 */
export const blockNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'must be lowercase kebab/snake case');

/**
 * A block *reference* — how a dependency names another block: bare (`crm`,
 * resolved in the registry the depending block came from — spec-03) or
 * namespaced (`@acme/billing`, naming a configured registry). A namespace is
 * a *source*, not an identity: the server ledger keys blocks by bare name.
 * The bare part is exactly the {@link blockNameSchema} grammar.
 */
export const blockRefSchema = z
  .string()
  .regex(
    /^(@[a-z][a-z0-9-]*\/)?[a-z][a-z0-9_-]*$/,
    'must be a block ref like "crm" or "@acme/billing"',
  );

/**
 * A canonical semver version — exactly what `semver.valid` normalises to, so
 * `v1.0.0` (prefix) and `1.0.0+build.1` (build metadata) are rejected rather
 * than silently normalised. The 32-char cap matches the `_ion_blocks.version`
 * column; it lives inside the refine (not `.max()`) so the rendered JSON
 * Schema stays a plain string — refinements don't emit, which keeps the
 * published registry schema files byte-stable.
 */
export const semverVersionSchema = z
  .string()
  .refine((v) => v.length <= 32 && semver.valid(v, { loose: false }) === v, {
    message: 'must be a canonical semver version like "0.2.0" (no "v" prefix, no build metadata)',
  });

/** Any range `semver.validRange` accepts: `^0.2.0`, `>=1.2 <2`, `1.x`, `*`. */
export const semverRangeSchema = z.string().refine((r) => semver.validRange(r) !== null, {
  message: 'must be a valid semver range (e.g. ">=0.2.0 <1.0.0")',
});

/**
 * Splits a block ref into its parts: `crm` → `{ name: 'crm' }`;
 * `@acme/billing` → `{ namespace: '@acme', name: 'billing' }`. Returns `null`
 * for anything the ref grammar rejects — including `crm@0.2.0` (version
 * pinning is CLI argument grammar, spec-03 — never part of a ref), uppercase
 * namespaces, and extra path segments.
 */
export function splitBlockRef(ref: string): { namespace?: string; name: string } | null {
  const match = /^(?:(@[a-z][a-z0-9-]*)\/)?([a-z][a-z0-9_-]*)$/.exec(ref);
  if (!match) return null;
  const namespace = match[1];
  const name = match[2];
  if (name === undefined) return null; // unreachable — the regex guarantees group 2
  return namespace === undefined ? { name } : { namespace, name };
}

// ---------------------------------------------------------------------------
// Zod schema — the single source of truth for manifest validation
// ---------------------------------------------------------------------------

/** Every column type the schema engine understands, as a Zod enum. */
const columnTypeSchema = z.enum(
  Object.keys(COLUMN_TYPES) as [keyof typeof COLUMN_TYPES, ...(keyof typeof COLUMN_TYPES)[]],
);

const fieldConstraintsSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    enumValues: z.array(z.string()).optional(),
    message: z.string().optional(),
  })
  .strict();

const fieldSchema = z
  .object({
    name: z.string().min(1).max(63),
    displayName: z.string().min(1).max(255),
    columnType: columnTypeSchema,
    isRequired: z.boolean().optional(),
    isUnique: z.boolean().optional(),
    isIndexed: z.boolean().optional(),
    defaultValue: z.string().nullish(),
    constraints: fieldConstraintsSchema.optional(),
    sortOrder: z.number().int().optional(),
    description: z.string().max(2000).optional(),
    /** Presentation-only UI metadata (control hint, enum colors, …). */
    uiOptions: z.record(z.unknown()).optional(),
  })
  .strict();

const objectSchema = z
  .object({
    name: z.string().min(1).max(63),
    displayName: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    fields: z.array(fieldSchema).min(1),
  })
  .strict();

const relationshipSchema = z
  .object({
    name: z.string().min(1).max(63),
    displayName: z.string().min(1).max(255),
    type: z.enum(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']),
    sourceObjectName: z.string().min(1),
    targetObjectName: z.string().min(1),
    cascadeDelete: z.boolean().optional(),
  })
  .strict();

const taskSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).nullish(),
    type: z.string().min(1).max(64),
    schedule: z.string().max(255).nullish(),
    timezone: z.string().max(64).nullish(),
    enabled: z.boolean().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict();

const roleSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    permissions: z
      .array(z.object({ resource: z.string(), actions: z.array(z.string()) }).strict())
      .min(1),
  })
  .strict();

const subscriptionSchema = z
  .object({
    /** Topic pattern to match (e.g. `data.#`, `data.*.created`). */
    event: z.string().min(1).max(255),
    /** Consumer group — the unit of at-most-once delivery. */
    consumer: z.string().min(1).max(255),
    /** Name of a registered bus handler (built-in like `persist_event`, or plugin-provided). */
    handler: z.string().min(1).max(64),
    /** When true, every instance forms its own group (once-per-instance delivery). */
    perInstance: z.boolean().optional(),
    /** Handler-specific configuration (e.g. `persist_event`'s target object + column map). */
    config: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Rejects a vendored code path that could escape `blocks/<block>/` when the
 * CLI writes it (spec-04 §5 hardening). Returns the human-readable problem,
 * or `null` when the path is safe. Order matters: backslashes are normalized
 * to `/` FIRST, then the normalized form is validated (never
 * validate-then-normalize — a `..\` would slip past a `/`-only check).
 *
 * KEEP IN SYNC with the CLI's `vendorPathIssue` in
 * `packages/cli/src/project.ts` — same rules, deliberately duplicated so the
 * CLI needs no runtime core dependency. Both test files share one
 * attack-vector list.
 */
export function codePathIssue(path: string): string | null {
  if (path.length < 1 || path.length > 200) return 'must be 1–200 characters';
  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized)) return 'must not be a Windows drive path';
  if (normalized.startsWith('//')) return 'must not be a UNC path';
  if (normalized.startsWith('/')) return 'must be relative (no leading /)';
  for (const segment of normalized.split('/')) {
    if (segment === '') return 'must not contain empty path segments';
    if (segment === '.') return 'must not contain "." segments';
    if (segment === '..') return 'must not contain ".." segments';
  }
  return null;
}

/** Bounds on the embedded `code[]` payload (spec-04 §5 — memory/DoS guard). */
const MAX_CODE_FILES = 500;
const MAX_TOTAL_CODE_BYTES = 5 * 1024 * 1024; // 5 MB across all files

/**
 * A vendored code file distributed with the block (Phase 14, ADR-018). The CLI
 * copies these into the user's project at `/blocks/<block>/<path>`; the server
 * ignores them at install time (the ledger keeps the snapshot for future
 * `diff` support). Paths are relative and must stay inside the block folder —
 * {@link codePathIssue} is the full spec-04 rule set (Windows drive/UNC forms,
 * `..`/`.`/empty segments, length), applied after the basic length bounds so
 * the published JSON Schema keeps its `minLength`/`maxLength`.
 */
const codeFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (p) => codePathIssue(p) === null,
        (p) => ({ message: codePathIssue(p) ?? 'must be a safe relative path' }),
      ),
    contents: z.string().max(512_000),
  })
  .strict();

/** The `code[]` array with its file-count + total-size caps (spec-04 §5). */
const codeArraySchema = z.array(codeFileSchema).superRefine((files, ctx) => {
  if (files.length > MAX_CODE_FILES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `code declares ${files.length} files (max ${MAX_CODE_FILES})`,
    });
  }
  const totalBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.contents, 'utf8'), 0);
  if (totalBytes > MAX_TOTAL_CODE_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `code embeds ${totalBytes} bytes in total (max ${MAX_TOTAL_CODE_BYTES})`,
    });
  }
});

/**
 * A callable action the block exposes (Phase 14). The *declaration* here is the
 * public surface (route + OpenAPI + MCP tool); the *implementation* is a
 * handler the block's vendored code registers via `ctx.actions.registerAction`.
 * Install fails if a declared action has no registered handler.
 */
const actionDeclarationSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase snake case'),
    description: z.string().max(2000).optional(),
    /** JSON-Schema description of the input payload (documentation surfaces only). */
    input: z.record(z.unknown()).optional(),
    /** RBAC override; default requires `update` on the `blocks` resource. */
    rbac: z
      .object({
        resource: z.string().min(1).max(64).optional(),
        action: z.enum(ACTIONS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** An inbound-webhook endpoint the block exposes at `/api/v1/hooks/<block>/<name>`. */
const hookDeclarationSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase snake case'),
    description: z.string().max(2000).optional(),
  })
  .strict();

/**
 * An *outbound* webhook the block provisions (Phase 12 / ADR-019): matching
 * bus events are POSTed, HMAC-signed, to `url`. The signing secret is
 * generated at install and surfaced once in the install report. Distinct from
 * `hooks`, which are inbound endpoints this server exposes.
 */
const outboundWebhookSchema = z
  .object({
    name: z.string().min(1).max(255),
    url: z.string().url().max(2000),
    topics: z.array(z.string().min(1).max(255)).min(1).max(50),
    headers: z.record(z.string().max(4000)).default({}),
  })
  .strict();

/**
 * What must be present in the runtime for the block to work (Phase 14 +
 * spec-02): `core` is a semver range the running core version must satisfy;
 * `handlers` are message-bus handler names; `plugins` are plugin names loaded
 * through the plugin host. All are validated at install time with actionable
 * errors ("did you vendor its code?" / naming the running core version).
 */
const requiresSchema = z
  .object({
    /** Semver range the running core version must satisfy (e.g. `>=0.2.0 <1.0.0`). */
    core: semverRangeSchema.optional(),
    handlers: z.array(z.string().min(1).max(128)).default([]),
    plugins: z.array(z.string().min(1).max(128)).default([]),
  })
  .strict();

/**
 * The building-block manifest (v1) — the shadcn `registry-item.json` analog.
 *
 * `name`/`version`/`title`/`description`/`author`/`categories`/`meta` are pure
 * metadata. `dependencies` maps *other blocks* that must be installed first
 * (the `registryDependencies` analog) to the semver range this block is
 * compatible with — a compatibility **constraint**, never a solver problem:
 * blocks are singletons per server. Everything else describes what the block
 * materialises in a running Ion Drive instance.
 */
export const blockManifestSchema = z
  .object({
    $schema: z.string().optional(),
    /** Unique, URL-safe block identifier (e.g. `crm`) — always namespace-free. */
    name: blockNameSchema,
    /** Strict canonical semver version (spec-02); powers range resolution + update diffing. */
    version: semverVersionSchema.default('0.1.0'),
    title: z.string().min(1).max(255),
    description: z.string().max(2000).default(''),
    author: z.string().max(255).optional(),
    categories: z.array(z.string()).default([]),
    /**
     * Blocks that must be installed first, as a block-ref → semver-range
     * record (e.g. `{ "crm": "^0.2.0" }`; `"*"` is the unconstrained escape
     * hatch). Checked at install: missing → 422, installed-but-out-of-range →
     * 422 `DEPENDENCY_VERSION` (spec-02).
     */
    dependencies: z.record(blockRefSchema, semverRangeSchema).default({}),
    /** npm packages a block's code files need at runtime (informational). */
    npmDependencies: z.record(z.string()).default({}),
    /** Environment variables the block expects (informational; surfaced to the operator). */
    envVars: z.record(z.string()).default({}),
    /** Data objects (tables) the block creates. */
    objects: z.array(objectSchema).default([]),
    /** Relationships wired between the block's (or existing) objects. */
    relationships: z.array(relationshipSchema).default([]),
    /** Seed records keyed by object name — inserted after the schema is applied. */
    seed: z.record(z.array(z.record(z.unknown()))).default({}),
    /** Scheduled/background tasks the block registers. */
    tasks: z.array(taskSchema).default([]),
    /** RBAC roles the block seeds (skipped if a role with the same name exists). */
    roles: z.array(roleSchema).default([]),
    /** Event subscriptions the block registers on the message bus (Phase 9). */
    subscriptions: z.array(subscriptionSchema).default([]),
    /** Callable actions exposed at `/api/v1/blocks/<name>/actions/<action>` (Phase 14). */
    actions: z.array(actionDeclarationSchema).default([]),
    /** Inbound webhooks exposed at `/api/v1/hooks/<name>/<hook>` (Phase 14). */
    hooks: z.array(hookDeclarationSchema).default([]),
    /** Outbound webhooks provisioned on install (Phase 12 / ADR-019). */
    webhooks: z.array(outboundWebhookSchema).default([]),
    /** Runtime requirements validated at install time (Phase 14). */
    requires: requiresSchema.default({ handlers: [], plugins: [] }),
    /** Vendored code files the CLI copies into the user's `/blocks/<name>/` (Phase 14). */
    code: codeArraySchema.default([]),
    /** Arbitrary metadata (docs URL, icon, etc.). */
    meta: z.record(z.unknown()).default({}),
  })
  .strict();

/**
 * Client-asserted install provenance (spec-04 §4): the CLI verifies the
 * artifact digest and attestation locally, then reports what it found in the
 * install envelope (`POST /api/v1/blocks/install` `{ manifest, source }`).
 * The server stores it in the `_ion_blocks` ledger for audit/ops ("which
 * servers installed the bad digest?") — it is **not** a server-side security
 * control (the RBAC manage-on-blocks guard is). Strict: unknown keys are
 * rejected so typos never silently drop provenance.
 */
export const installSourceSchema = z
  .object({
    /** Registry namespace the block came from (e.g. `@ion`). */
    registry: z.string().max(128).optional(),
    /** The exact artifact URL. */
    url: z.string().url().max(2000).optional(),
    /** `sha256:<hex>` the client computed over the artifact bytes. */
    digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    /** Whether a sigstore attestation verified for these bytes. */
    attested: z.boolean().optional(),
    /** Who published it (e.g. `github.com/jaredgrabill/ion-drive-blocks`). */
    publisher: z.string().max(255).optional(),
    /** The trust tier the client computed (never self-asserted by registries). */
    tier: z.enum(['official', 'verified', 'community']).optional(),
  })
  .strict();

/** A parsed install-source envelope. */
export type BlockInstallSource = z.infer<typeof installSourceSchema>;

// ---------------------------------------------------------------------------
// Derived TypeScript types
// ---------------------------------------------------------------------------

/** A fully-parsed, defaults-applied manifest. */
export type BlockManifest = z.infer<typeof blockManifestSchema>;

/** The manifest shape as authored (before Zod applies defaults). */
export type BlockManifestInput = z.input<typeof blockManifestSchema>;

export type BlockObject = z.infer<typeof objectSchema>;
export type BlockRelationship = z.infer<typeof relationshipSchema>;
export type BlockRole = z.infer<typeof roleSchema>;
export type BlockSubscription = z.infer<typeof subscriptionSchema>;
export type BlockActionDeclaration = z.infer<typeof actionDeclarationSchema>;
export type BlockHookDeclaration = z.infer<typeof hookDeclarationSchema>;
export type BlockOutboundWebhook = z.infer<typeof outboundWebhookSchema>;
export type BlockCodeFile = z.infer<typeof codeFileSchema>;

/**
 * Lifecycle status of an installed block, tracked in `_ion_blocks`.
 * `installed` — fully applied; `failed` — a partial install we recorded for
 * diagnosis; `installing` — in-flight (guards against concurrent installs).
 */
export type BlockStatus = 'installing' | 'installed' | 'failed';

/** A row of the `_ion_blocks` install ledger, surfaced to the API. */
export interface InstalledBlock {
  name: string;
  version: string;
  title: string;
  status: BlockStatus;
  /** Object names this block created (used for clean uninstall). */
  createdObjects: string[];
  /** The full manifest snapshot as installed (so the consumer owns their copy). */
  manifest: BlockManifest;
  // Provenance from the install `source` envelope (spec-04). All nullable:
  // bare-manifest installs (curl, tests) record nothing.
  /** `sha256:<hex>` the installing client computed over the artifact bytes. */
  artifactDigest: string | null;
  /** Registry namespace it came from (e.g. `@ion`). */
  sourceRegistry: string | null;
  /** The exact artifact URL. */
  sourceUrl: string | null;
  /** Who published it (e.g. `github.com/jaredgrabill/ion-drive-blocks`). */
  publisher: string | null;
  /** Whether the installing client verified a sigstore attestation. */
  attested: boolean | null;
  /** Trust tier the installing client computed (`official`/`verified`/`community`). */
  trustTier: string | null;
  installedAt: Date;
  updatedAt: Date;
}

/**
 * Result of applying a manifest — a human-readable account of what changed,
 * mirroring the schema engine's ChangePreview philosophy. Also used in
 * `dryRun` (preview) mode, where nothing is written.
 */
export interface BlockInstallReport {
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
  subscriptionsRegistered: string[];
  /** Actions exposed at `/api/v1/blocks/<block>/actions/<name>` (Phase 14). */
  actionsExposed: string[];
  /** Hooks exposed at `/api/v1/hooks/<block>/<name>` (Phase 14). */
  hooksExposed: string[];
  /**
   * Outbound webhooks provisioned, with their once-only signing secrets
   * (`name: secret`) — surfaced here because they are never readable again.
   */
  webhooksCreated: Record<string, string>;
  webhooksSkipped: string[];
  // --- Upgrade-mode fields (spec-07). Empty on plain installs. ---
  /** Present when this report came from the installer's upgrade mode. */
  upgraded?: { from: string; to: string };
  /**
   * Items the old version created that the new manifest no longer declares,
   * kept (no force) and released to `user` management — they are the user's
   * now, like vendored code (ADR-018).
   */
  released: string[];
  /** Destructive manifest changes reported and skipped (apply with force). */
  skippedDestructive: string[];
  /** Tasks updated in place (definition changed; `enabled` preserved). */
  tasksUpdated: string[];
  /** Tasks removed because the new manifest dropped them (force only). */
  tasksRemoved: string[];
  /** Outbound webhooks updated in place (secret preserved). */
  webhooksUpdated: string[];
  /** Outbound webhooks removed by provenance (dropped from the manifest). */
  webhooksRemoved: string[];
  /** The structural old→new manifest delta (upgrade mode only). */
  delta?: ManifestDelta;
  /**
   * Schema-engine previews gathered during an upgrade **dry run** (modifying
   * fields + forced destructive changes) — the CLI renders these verbatim.
   */
  previews?: UpgradePreviewEntry[];
  warnings: string[];
}

/** One schema-engine preview surfaced by an upgrade dry run. */
export interface UpgradePreviewEntry {
  /** What the preview is for, e.g. `field contacts.status` / `object leads`. */
  target: string;
  sqlStatements: string[];
  warnings: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Structural bridges to the schema/task engines
// ---------------------------------------------------------------------------

/**
 * Converts a manifest object into the schema engine's DataObjectDefinition.
 * When `blockName` is given, the object and every field it declares are
 * stamped `block:<name>` — the provenance that powers contract protection
 * (ADR-017). Pre-existing/skipped objects keep their original owner because
 * the installer never re-creates them.
 */
export function toDataObjectDefinition(obj: BlockObject, blockName?: string): DataObjectDefinition {
  const managedBy = blockName ? (`block:${blockName}` as const) : undefined;
  return {
    name: obj.name,
    displayName: obj.displayName,
    description: obj.description,
    tableName: obj.name,
    managedBy,
    fields: obj.fields.map(
      (f): FieldDefinition => ({
        name: f.name,
        displayName: f.displayName,
        columnName: f.name,
        columnType: f.columnType,
        isRequired: f.isRequired,
        isUnique: f.isUnique,
        isIndexed: f.isIndexed,
        defaultValue: f.defaultValue ?? undefined,
        constraints: f.constraints,
        sortOrder: f.sortOrder,
        description: f.description,
        uiOptions: f.uiOptions,
        managedBy,
      }),
    ),
  };
}

/** Converts a manifest relationship into the schema engine's definition. */
export function toRelationshipDefinition(
  rel: BlockRelationship,
  blockName?: string,
): RelationshipDefinition {
  return {
    name: rel.name,
    displayName: rel.displayName,
    type: rel.type,
    sourceObjectName: rel.sourceObjectName,
    targetObjectName: rel.targetObjectName,
    cascadeDelete: rel.cascadeDelete,
    managedBy: blockName ? `block:${blockName}` : undefined,
  };
}

/** Converts a manifest task into the task engine's TaskInput. */
export function toTaskInput(task: BlockManifest['tasks'][number]): TaskInput {
  return {
    name: task.name,
    description: task.description ?? null,
    type: task.type,
    schedule: task.schedule ?? null,
    timezone: task.timezone ?? null,
    enabled: task.enabled,
    config: task.config,
  };
}

/** Converts a manifest subscription into the message bus's Subscription, tagging its source block. */
export function toSubscriptionInput(sub: BlockSubscription, source: string): Subscription {
  return {
    topic: sub.event,
    consumer: sub.consumer,
    handler: sub.handler,
    perInstance: sub.perInstance,
    config: sub.config,
    source,
  };
}
