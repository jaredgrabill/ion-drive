/**
 * Chart components barrel.
 *
 * Exposes the **lazy** chart wrappers (recharts is code-split — see
 * lazy.tsx) plus the lightweight pure-SVG SparkLine. Import the eager chart
 * modules directly only from tests.
 */

export * from './lazy';
export * from './spark-line';
