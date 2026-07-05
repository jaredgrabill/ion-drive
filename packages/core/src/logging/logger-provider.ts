/**
 * Logging port.
 *
 * Ion Drive logs through the {@link LoggerProvider} interface so the underlying
 * sink is swappable by a plugin, while the OpenTelemetry log bridge (Phase 5)
 * stays wired by default. The default adapter ({@link PinoLoggerProvider})
 * simply delegates to the Fastify/pino logger already created in `server.ts`;
 * the shape intentionally matches the task engine's `TaskLogger` so the two are
 * interchangeable.
 */

/** Structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

/** The minimal logger surface the platform depends on. */
export interface LoggerProvider {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps `bindings` onto every line. */
  child(bindings: LogFields): LoggerProvider;
}

/** The subset of a pino logger the default adapter needs. */
interface PinoLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  child(bindings: object): PinoLike;
}

/**
 * Default {@link LoggerProvider} backed by a pino logger (Fastify's `server.log`).
 * Pino takes the structured object first and the message second, which this
 * adapter maps from the `(message, fields)` signature.
 */
export class PinoLoggerProvider implements LoggerProvider {
  constructor(private readonly logger: PinoLike) {}

  info(message: string, fields?: LogFields): void {
    this.logger.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.logger.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.logger.error(fields ?? {}, message);
  }

  debug(message: string, fields?: LogFields): void {
    this.logger.debug(fields ?? {}, message);
  }

  child(bindings: LogFields): LoggerProvider {
    return new PinoLoggerProvider(this.logger.child(bindings));
  }
}
