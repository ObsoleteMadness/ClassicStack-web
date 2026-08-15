/** In-app event log for diagnosing the LocalTalk / AFP stack. */

export type LogLevel = 'trace' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  id: number;
  time: Date;
  level: LogLevel;
  message: string;
  source?: string;
}

export type LogListener = (entry: LogEntry) => void;

export function meetsLevel(entry: LogLevel, min: LogLevel): boolean {
  return LEVEL_RANK[entry] >= LEVEL_RANK[min];
}

class Logger {
  private entries: LogEntry[] = [];
  private listeners = new Set<LogListener>();
  private nextId = 1;
  private maxEntries = 2500;
  private consoleBridged = false;

  subscribe(fn: LogListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }

  log(level: LogLevel, message: string, source?: string): void {
    const entry: LogEntry = {
      id: this.nextId++,
      time: new Date(),
      level,
      message,
      source,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    for (const fn of this.listeners) fn(entry);
  }

  trace(message: string, source?: string): void {
    this.log('trace', message, source);
  }

  info(message: string, source?: string): void {
    this.log('info', message, source);
  }

  warn(message: string, source?: string): void {
    this.log('warn', message, source);
  }

  error(message: string, source?: string): void {
    this.log('error', message, source);
  }

  /** Mirror console.* into the in-app log without breaking existing callers. */
  installConsoleBridge(): void {
    if (this.consoleBridged || typeof console === 'undefined') return;
    this.consoleBridged = true;

    const orig = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    };

    const format = (args: unknown[]): string =>
      args
        .map((a) => {
          if (typeof a === 'string') return a;
          if (a instanceof Error) return a.stack || a.message;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');

    console.log = (...args: unknown[]) => {
      orig.log(...args);
      this.info(format(args), 'console');
    };
    console.info = (...args: unknown[]) => {
      orig.info(...args);
      this.info(format(args), 'console');
    };
    console.warn = (...args: unknown[]) => {
      orig.warn(...args);
      this.warn(format(args), 'console');
    };
    console.error = (...args: unknown[]) => {
      orig.error(...args);
      this.error(format(args), 'console');
    };
    console.debug = (...args: unknown[]) => {
      orig.debug(...args);
      this.trace(format(args), 'console');
    };
  }
}

export const log = new Logger();
