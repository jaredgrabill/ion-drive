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
 * A vendored code file distributed with the block (Phase 14, ADR-018). The CLI
 * copies these into the user's project at `/blocks/<block>/<path>`; the server
 * ignores them at install time (the ledger keeps the snapshot for future
 * `diff` support). Paths are relative and must stay inside the block folder.
 */
const codeFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(255)
      .refine((p) => !p.startsWith('/') && !p.includes('..'), 'must be a safe relative path'),
    contents: z.string().max(512_000),
  })
  .strict();

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
 * What must be present in the runtime for the block to work (Phase 14):
 * `handlers` are message-bus handler names; `plugins` are plugin names loaded
 * through the plugin host. Both are validated at install time with actionable
 * errors ("did you vendor its code?").
 */
const requiresSchema = z
  .object({
    handlers: z.array(z.string().min(1).max(128)).default([]),
    plugins: z.array(z.string().min(1).max(128)).default([]),
  })
  .strict();

/**
 * The building-block manifest — the shadcn `registry-item.json` analog.
 *
 * `name`/`version`/`title`/`description`/`author`/`categories`/`meta` are pure
 * metadata. `dependencies` names *other blocks* that must be installed first
 * (the `registryDependencies` analog). Everything else describes what the block
 * materialises in a running Ion Drive instance.
 */
export const blockManifestSchema = z
  .object({
    $schema: z.string().optional(),
    /** Unique, URL-safe block identifier (e.g. `crm`). */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/, 'must be lowercase kebab/snake case'),
    /** Semver-ish version string for update diffing. */
    version: z.string().min(1).max(32).default('0.1.0'),
    title: z.string().min(1).max(255),
    description: z.string().max(2000).default(''),
    author: z.string().max(255).optional(),
    categories: z.array(z.string()).default([]),
    /** Names of other blocks this block requires (installed first). */
    dependencies: z.array(z.string()).default([]),
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
    /** Runtime requirements validated at install time (Phase 14). */
    requires: requiresSchema.default({ handlers: [], plugins: [] }),
    /** Vendored code files the CLI copies into the user's `/blocks/<name>/` (Phase 14). */
    code: z.array(codeFileSchema).default([]),
    /** Arbitrary metadata (docs URL, icon, etc.). */
    meta: z.record(z.unknown()).default({}),
  })
  .strict();

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
  warnings: string[];
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
