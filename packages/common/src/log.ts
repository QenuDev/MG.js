/**
 * Levelled logging with a pluggable sink.
 *
 * Small on purpose: a userscript shares a page with the game's own console, and a chatty wrapper is
 * worse than a silent one. The default sink writes through `console` with a namespace prefix; both
 * clients can swap it for a ring buffer (bootstrapped) or a file (headless) without touching call
 * sites.
 *
 * THE CREDENTIAL BOUNDARY IS HERE
 * -------------------------------
 * DESIGN I3 says `mc_jwt` appears in exactly one place, the `Cookie` header at connect time, and the
 * Logging section says redaction happens at the boundary rather than at each call site. A sink is the
 * last thing every record passes through and `MemoryLogSink.snapshot()` exists "for a bug-report dump",
 * so this is where {@link redactCredential} is applied. Call sites stay free to log whatever they have.
 */

import { redactCredential, redactCredentialString } from './redact.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/** Receives every record that passes the level filter. */
export interface LogSink {
  write(record: LogRecord): void;
}

export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>;
  namespace: string;
  message: string;
  /** Structured context: the fields worth grepping for. */
  fields?: Record<string, unknown>;
  /** The underlying error, when the record was produced by a catch. */
  error?: unknown;
  timestamp: number;
}

/** Writes records to the console. */
export class ConsoleLogSink implements LogSink {
  write(record: LogRecord): void {
    const prefix = `[${record.namespace}]`;
    const args: unknown[] = [prefix, record.message];
    if (record.fields && Object.keys(record.fields).length > 0) args.push(record.fields);
    if (record.error !== undefined) args.push(record.error);

    // eslint-disable-next-line no-console
    const target = console[record.level === 'trace' ? 'debug' : record.level] as
      | ((...a: unknown[]) => void)
      | undefined;
    if (typeof target === 'function') target.apply(console, args);
  }
}

/** Collects records in memory, for debugging or for a bug-report dump. */
export class MemoryLogSink implements LogSink {
  private readonly records: LogRecord[] = [];
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.limit) this.records.shift();
  }

  /** A copy of everything captured so far. */
  snapshot(): LogRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** Forwards to several sinks. */
export class MultiLogSink implements LogSink {
  private readonly sinks: LogSink[];

  constructor(sinks: LogSink[]) {
    this.sinks = sinks;
  }

  write(record: LogRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.write(record);
      } catch {
        // A broken sink must never break the wrapper.
      }
    }
  }
}

/** A namespaced logger. */
export interface Logger {
  trace(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, error?: unknown, fields?: Record<string, unknown>): void;
  /** A logger that prefixes this one's namespace, e.g. `mg:headless` + `transport`. */
  child(namespace: string): Logger;
  /** The current level. */
  level(): LogLevel;
  /** Change the level at runtime. */
  setLevel(level: LogLevel): void;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Namespace prefix, e.g. `mg:headless`. */
  namespace?: string;
  /** Minimum level to emit. Default `warn`, so the logger is quiet unless asked. */
  level?: LogLevel;
  /** Where records go. Default a {@link ConsoleLogSink}. */
  sink?: LogSink;
}

/** Create a logger tree. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const namespace = options.namespace ?? 'mg';
  let level: LogLevel = options.level ?? 'warn';
  const sink = options.sink ?? new ConsoleLogSink();

  const scrub = (error: unknown, seen = new WeakSet<object>()): unknown => {
    if (!(error instanceof Error)) return redactCredential(error);
    // A `cause` chain is a graph, not a tree: `error.cause = error` is legal and would recurse forever.
    if (seen.has(error)) return error;
    seen.add(error);

    // A real `Error` is preserved so a sink can read `.name`/`.code` and a console can print a stack; only
    // the parts that can quote a rejected header are rewritten.
    //
    // The stack is rewritten too, and that is not belt-and-braces: the engine puts the message into the
    // stack string, and `console.error` prints the whole thing, so a redacted `.message` beside an
    // untouched `.stack` leaks the thing the message was scrubbed for.
    const message = redactCredentialString(error.message);
    const stack = error.stack === undefined ? undefined : redactCredentialString(error.stack);
    // The cause chain is scrubbed as well, and it is what makes the early return below honest: an error
    // whose own message is innocent can still be wrapping the one that quotes the header, and
    // `util.inspect` follows the cause into a pasted bug report. Deciding "nothing to redact" by looking
    // only at this link is how a scrubbed message ends up printed beside an unscrubbed cause.
    const cause = (error as Error & { cause?: unknown }).cause;
    const scrubbedCause = cause === undefined ? undefined : scrub(cause, seen);

    if (message === error.message && stack === error.stack && scrubbedCause === cause) return error;

    const replacement = new Error(message);
    replacement.name = error.name;
    // Copied rather than regenerated: a stack recorded here would point at this function instead of the
    // throw site, which is the only thing a stack is for.
    if (stack !== undefined) replacement.stack = stack;
    if (scrubbedCause !== undefined) (replacement as Error & { cause?: unknown }).cause = scrubbedCause;
    // `.code` is the machine-readable half of the failure (`ECONNREFUSED`, `config_headers_unsupported`).
    // A sink that branches on it must not lose it to the rewrite, so it travels with the redacted copy.
    const coded = error as Error & { code?: unknown };
    if (coded.code !== undefined) (replacement as Error & { code?: unknown }).code = coded.code;
    return replacement;
  };

  const emit = (
    recordLevel: Exclude<LogLevel, 'silent'>,
    message: string,
    fields?: Record<string, unknown>,
    error?: unknown,
  ): void => {
    if (level === 'silent') return;
    if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return;
    const record: LogRecord = {
      level: recordLevel,
      namespace,
      // The message is a plain string and can interpolate anything; redact it too.
      message: redactCredentialString(message),
      timestamp: Date.now(),
    };
    if (fields !== undefined) record.fields = redactCredential(fields);
    if (error !== undefined) record.error = scrub(error);
    try {
      sink.write(record);
    } catch {
      // Never let logging break the caller.
    }
  };

  const logger: Logger = {
    trace: (message, fields) => emit('trace', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, error, fields) => emit('error', message, fields, error),
    child: (childNamespace) => {
      const child = createLogger({ namespace: `${namespace}:${childNamespace}`, level, sink });
      // Keep the child's level in step with the parent after this point.
      return Object.assign(child, {
        level: () => level,
        setLevel: (next: LogLevel) => {
          level = next;
        },
      }) as Logger;
    },
    level: () => level,
    setLevel: (next) => {
      level = next;
    },
  };

  return logger;
}

/** A logger that discards everything, useful as a default in tests. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    level: () => 'silent',
    setLevel: noop,
  };
  return logger;
}
