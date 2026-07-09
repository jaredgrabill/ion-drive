/**
 * Trust hint badge — displays the registry-asserted `trust` string
 * (ion-green `official` / ion-cyan `verified` / neutral everything else).
 * Real trust is computed client-side by the CLI (spec-04); the browser only
 * ever displays hints and points at `ion-drive block verify`.
 */

export function TrustBadge({ trust }: { trust: string }) {
  return (
    <span
      className="trust-badge"
      data-trust={trust}
      title="Registry-asserted hint — verify locally"
    >
      {trust}
    </span>
  );
}
