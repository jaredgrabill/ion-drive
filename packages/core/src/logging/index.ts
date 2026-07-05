/**
 * Logging module barrel — the swappable {@link LoggerProvider} port, its default
 * pino adapter, and the registry token used to resolve/replace it.
 */

import { serviceToken } from '../runtime/service-registry.js';
import type { LoggerProvider } from './logger-provider.js';

export { PinoLoggerProvider } from './logger-provider.js';
export type { LoggerProvider, LogFields } from './logger-provider.js';

/** Registry token for the platform logger. */
export const LOGGER_SERVICE = serviceToken<LoggerProvider>('logger');
