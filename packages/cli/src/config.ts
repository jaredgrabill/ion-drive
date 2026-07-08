/**
 * Local project configuration for the CLI (`ion.config.json`).
 *
 * `ion-drive init` writes this file; `add`/`remove`/`list`/`registry` read it
 * to find the target server, credentials, and configured block registries.
 * It also records which blocks the project has installed — an enriched record
 * (`name`/`version`/`digest`/`source`/`sourceUrl`/`installedAt`) that doubles
 * as the project's lockfile (ADR-022: blocks are singletons per server, so a
 * separate lockfile would carry no extra facts). The `digest` field is the
 * sha256 verified by spec-04's install gate (`null` only for records written
 * by pre-spec-04 CLIs).
 *
 * Registries (spec-03 §1) are a namespace → URL map in the shadcn-3.0 shape:
 * a plain URL string or `{ url, headers?, params? }` for private registries.
 * `headers`/`params` values support `${VAR}` placeholders expanded from the
 * environment **at fetch time** ({@link expandEnvPlaceholders} — an unset
 * variable is a hard, named error before any network call). `@ion` is built
 * in and overridable; `ION_DRIVE_REGISTRY` overrides the *default* registry's
 * URL for the invocation (the CI/dev escape hatch).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CONFIG_FILENAME = 'ion.config.json';

/** Thrown for configuration problems (bad registry refs, unset `${VAR}`s, …). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** The built-in registries — present even when `registries` is absent. */
export const BUILT_IN_REGISTRIES: Record<string, string> = {
  '@ion': 'https://registry.iondrive.dev/registry/index.json',
};

/** The default default-registry namespace. */
export const DEFAULT_REGISTRY_NAMESPACE = '@ion';

/** A configured registry in its object form. */
export interface RegistryEntryConfig {
  url: string;
  /** Extra request headers; values may use `${VAR}` placeholders. */
  headers?: Record<string, string>;
  /** Query params appended to every request to this registry; `${VAR}` ok. */
  params?: Record<string, string>;
}

/** A registry as normalized by {@link effectiveRegistries}. */
export interface NormalizedRegistry {
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
}

/** One installed block's record — the project's lockfile entry (spec-03 §1). */
export interface InstalledBlockRecord {
  name: string;
  version: string;
  /** `sha256:<hex>` of the installed artifact (verified at add time, spec-04). */
  digest: string | null;
  /** Where it came from: a registry namespace (`@ion`), `local`, or a URL. */
  source: string;
  /** The exact artifact URL, when installed from a registry or URL. */
  sourceUrl?: string;
  installedAt: string;
}

export interface IonProjectConfig {
  /** Base URL of the target Ion Drive server. */
  serverUrl: string;
  /** API key (`iond_…`) used to authenticate management calls, if any. */
  apiKey?: string;
  /** Registry namespaces (`"@acme": url | { url, headers?, params? }`). */
  registries?: Record<string, string | RegistryEntryConfig>;
  /** Namespace bare refs resolve in (default `@ion`). */
  defaultRegistry?: string;
  /** Legacy (pre-spec-03) field — no longer read; warned about once. */
  registryUrl?: string;
  /** Blocks installed into this project (local mirror of the server ledger). */
  blocks: InstalledBlockRecord[];
}

const DEFAULTS: IonProjectConfig = {
  serverUrl: 'http://localhost:3000',
  blocks: [],
};

/** Absolute path to `ion.config.json` in the given directory. */
export function configPath(dir = process.cwd()): string {
  return join(resolve(dir), CONFIG_FILENAME);
}

export function configExists(dir = process.cwd()): boolean {
  return existsSync(configPath(dir));
}

/** Warnings already printed this process (once-per-process de-dup). */
let warningsPrinted = false;

/**
 * Reads the project config, applying defaults for any missing fields, and
 * prints {@link configWarnings} once per process (via `console.warn`, so the
 * pure helpers stay UI-free).
 */
export function readConfig(dir = process.cwd()): IonProjectConfig {
  const path = configPath(dir);
  if (!existsSync(path)) return { ...DEFAULTS };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IonProjectConfig>;
  if (!warningsPrinted) {
    warningsPrinted = true;
    for (const warning of configWarnings(parsed)) console.warn(`▲ ${warning}`);
  }
  return { ...DEFAULTS, ...parsed, blocks: parsed.blocks ?? [] };
}

/** Test hook: re-arms the once-per-process config warnings. */
export function resetConfigWarnings(): void {
  warningsPrinted = false;
}

/**
 * Pure: the warnings a parsed config deserves — the legacy `registryUrl`
 * migration nudge and the secret-hygiene check (a literal-looking token in
 * `headers`/`params` of a file that gets committed).
 */
export function configWarnings(parsed: Partial<IonProjectConfig>): string[] {
  const warnings: string[] = [];
  if (parsed.registryUrl !== undefined) {
    warnings.push(
      '`registryUrl` is no longer read — declare it under `registries` and set `defaultRegistry`',
    );
  }
  for (const [namespace, entry] of Object.entries(parsed.registries ?? {})) {
    if (typeof entry !== 'string') warnings.push(...secretWarnings(namespace, entry));
  }
  return warnings;
}

/** Flags literal-looking secrets in one registry entry's headers/params. */
function secretWarnings(namespace: string, entry: RegistryEntryConfig): string[] {
  const warnings: string[] = [];
  for (const values of [entry.headers ?? {}, entry.params ?? {}]) {
    for (const [key, value] of Object.entries(values)) {
      if (/[A-Za-z0-9_-]{20,}/.test(value) && !value.includes('${')) {
        warnings.push(
          `registry ${namespace} has a literal-looking secret in "${key}" — use \`\${ENV_VAR}\` — this file gets committed`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Pure: the effective registry map — built-ins merged under user overrides,
 * every entry normalized to `{ url, headers, params }`, and the
 * `ION_DRIVE_REGISTRY` env override applied to the **default** registry's URL.
 * `${VAR}` placeholders in headers/params are NOT expanded here — that
 * happens at fetch time ({@link expandEnvPlaceholders}) so an unset variable
 * only fails commands that actually contact that registry.
 */
export function effectiveRegistries(
  config: IonProjectConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, NormalizedRegistry> {
  const merged: Record<string, NormalizedRegistry> = {};
  for (const [namespace, url] of Object.entries(BUILT_IN_REGISTRIES)) {
    merged[namespace] = { url, headers: {}, params: {} };
  }
  for (const [namespace, entry] of Object.entries(config.registries ?? {})) {
    merged[namespace] =
      typeof entry === 'string'
        ? { url: entry, headers: {}, params: {} }
        : { url: entry.url, headers: { ...entry.headers }, params: { ...entry.params } };
  }

  const override = env.ION_DRIVE_REGISTRY;
  if (override) {
    const ns = defaultRegistryNamespace(config);
    const current = merged[ns] ?? { url: override, headers: {}, params: {} };
    merged[ns] = { ...current, url: override };
  }
  return merged;
}

/**
 * Pure: the namespace bare refs resolve in. Defaults to `@ion`; a
 * `defaultRegistry` naming an unconfigured namespace is a {@link ConfigError}.
 */
export function defaultRegistryNamespace(config: IonProjectConfig): string {
  const ns = config.defaultRegistry ?? DEFAULT_REGISTRY_NAMESPACE;
  const known =
    ns in BUILT_IN_REGISTRIES || (config.registries !== undefined && ns in config.registries);
  if (!known) {
    throw new ConfigError(
      `defaultRegistry "${ns}" is not configured — add ${ns} to registries in ion.config.json`,
    );
  }
  return ns;
}

/**
 * Expands `${VAR}` placeholders in a header/param value from the environment.
 * An unset variable is a hard, named error **before any network call** —
 * called at fetch time, never at config load.
 * @throws {ConfigError} naming the variable and the registry
 */
export function expandEnvPlaceholders(
  value: string,
  env: Record<string, string | undefined>,
  registry: string,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new ConfigError(
        `Environment variable ${name} is not set (needed by registry ${registry} in ion.config.json)`,
      );
    }
    return resolved;
  });
}

/** Writes the project config back to disk (pretty-printed). */
export function writeConfig(config: IonProjectConfig, dir = process.cwd()): void {
  writeFileSync(configPath(dir), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** Input to {@link recordInstalled} — `installedAt` is stamped here. */
export interface InstalledBlockInput {
  name: string;
  version: string;
  digest: string | null;
  source: string;
  sourceUrl?: string;
}

/** Records (or updates) an installed block in the local config. */
export function recordInstalled(
  config: IonProjectConfig,
  input: InstalledBlockInput,
): IonProjectConfig {
  const blocks = config.blocks.filter((b) => b.name !== input.name);
  blocks.push({ ...input, installedAt: new Date().toISOString() });
  blocks.sort((a, b) => a.name.localeCompare(b.name));
  return { ...config, blocks };
}

/** Removes a block record from the local config (used by `ion-drive remove`). */
export function recordRemoved(config: IonProjectConfig, name: string): IonProjectConfig {
  return { ...config, blocks: config.blocks.filter((b) => b.name !== name) };
}
