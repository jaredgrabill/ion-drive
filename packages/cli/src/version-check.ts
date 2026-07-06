/**
 * CLI ↔ server version-skew guard (Phase 14 Tier 0).
 *
 * The CLI's scaffolds and catalog expectations track the platform release
 * train (all `@ion-drive/*` packages share one fixed version). When the CLI
 * talks to a server on a different `major.minor`, behavior may differ in ways
 * the CLI can't detect — so commands **warn** (never fail) before proceeding.
 * The server's version rides along on `GET /health` and `GET /api/v1/version`;
 * commands pass whichever payload they already fetched.
 */

import { createRequire } from 'node:module';
import { log } from './ui.js';

/** This CLI's own package version, read once (works from src and dist). */
export const CLI_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

/** Parses `major.minor` from a semver-ish string; null when unparsable. */
function majorMinor(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!match?.[1] || !match[2]) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Returns a human-readable skew warning when the CLI and server differ on
 * `major.minor` (patch drift is fine), or null when compatible/unknown.
 * Pure — unit-tested directly.
 */
export function versionSkewMessage(
  cliVersion: string,
  serverVersion: string | undefined,
): string | null {
  if (!serverVersion) return null;
  const cli = majorMinor(cliVersion);
  const server = majorMinor(serverVersion);
  if (!cli || !server) return null;
  if (cli.major === server.major && cli.minor === server.minor) return null;
  return `CLI v${cliVersion} ≠ server v${serverVersion} — scaffolds/commands may not match this server. Align them: pnpm add -g @ion-drive/cli@<server version> (or upgrade the server).`;
}

/** Prints the skew warning (if any) for a server version. Never throws. */
export function warnOnVersionSkew(serverVersion: string | undefined): void {
  const message = versionSkewMessage(CLI_VERSION, serverVersion);
  if (message) log.warn(message);
}
