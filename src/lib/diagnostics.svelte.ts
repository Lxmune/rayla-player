// In-memory diagnostics log: a ring buffer of redacted, timestamped lines (engine events,
// reported errors, window errors, console warnings/errors) that users can copy into a bug report.
import type { EngineEvent } from './ipc';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  source: string;
  text: string;
}

const SECRET_PARAM = /([?&;](?:api_key|apikey|token|access_token|api_sig|sk|password|pw|secret|key)=)[^&\s"')]*/gi;
const SECRET_HEADER =
  /((?:X-Emby-Token|X-MediaBrowser-Token|Authorization|Cookie)["']?\s*[:=]\s*["']?)(?:MediaBrowser\s+)?[^\s,"';]+(?:\s+Token="[^"]*")?/gi;
const SECRET_FIELD = /((?:token|password|passwd|api[_-]?key|secret|accesstoken)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi;
const USERINFO = /(\bhttps?:\/\/)[^\s/@]+:[^\s/@]+@/gi;

/** Strips tokens, passwords, api_key query params and URL credentials from a log line. */
export function redact(text: string): string {
  return text
    .replace(USERINFO, '$1***@')
    .replace(SECRET_PARAM, '$1***')
    .replace(SECRET_HEADER, '$1***')
    .replace(SECRET_FIELD, '$1***');
}

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;
}

/**
 * Condenses an engine event to a log line, or null when it is noise (position ticks, repeated
 * identical states, fetchProgress updates that are not the final one).
 */
export function summarizeEngineEvent(e: EngineEvent, last: { state: string | null }): string | null {
  switch (e.kind) {
    case 'position':
      return null;
    case 'stateChanged':
      if (last.state === e.state) return null;
      last.state = e.state;
      return `state -> ${e.state}`;
    case 'trackStarted':
      return `track started ${e.trackId ?? '?'}`;
    case 'trackEnded':
      return `track ended ${e.trackId ?? '?'}`;
    case 'error':
      return `ENGINE ERROR${e.trackId ? ` (track ${e.trackId})` : ''}: ${e.message ?? 'unknown'}`;
    case 'signalPathChanged': {
      const s = e.signalPath;
      if (!s) return 'signal path cleared';
      return `signal path: ${s.codec} ${s.sourceSampleRate} Hz/${s.sourceBitDepth || 'float'} -> ${s.deviceName} ${s.outputSampleRate} Hz/${s.outputBitDepth}${s.exclusive ? ' exclusive' : ''}${s.bitPerfect ? ' bit-perfect' : ''} [${s.stages.join(', ')}]`;
    }
    case 'throughput':
      return `throughput ${(e.throughputBps / 1e6).toFixed(2)} Mbit/s (track ${e.trackId ?? '?'})`;
    case 'fetchProgress':
      // Only the completion (or a coarse progress line) is interesting.
      if (e.totalBytes > 0 && e.cachedBytes >= e.totalBytes)
        return `fetch complete ${fmtBytes(e.totalBytes)} (track ${e.trackId ?? '?'})`;
      return null;
    default:
      return null;
  }
}

export class Diagnostics {
  entries = $state.raw<LogEntry[]>([]);
  private readonly capacity: number;
  private readonly clock: () => number;
  private engineLast: { state: string | null } = { state: null };
  private stops: (() => void)[] = [];

  constructor(opts: { capacity?: number; clock?: () => number } = {}) {
    this.capacity = opts.capacity ?? 500;
    this.clock = opts.clock ?? Date.now;
  }

  log(level: LogLevel, source: string, text: string): void {
    const entry: LogEntry = { at: this.clock(), level, source, text: redact(text) };
    const next = [...this.entries, entry];
    this.entries = next.length > this.capacity ? next.slice(next.length - this.capacity) : next;
  }

  engineEvent(e: EngineEvent): void {
    const line = summarizeEngineEvent(e, this.engineLast);
    if (line) this.log(e.kind === 'error' ? 'error' : 'info', 'engine', line);
  }

  get errors(): LogEntry[] {
    return this.entries.filter((e) => e.level === 'error');
  }

  clear(): void {
    this.entries = [];
  }

  /** Plain-text report with a header, oldest line first. */
  format(header: string[] = []): string {
    const lines = this.entries.map(
      (e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.text}`,
    );
    return [...header.map(redact), '', ...lines].join('\n');
  }

  /** Hooks window errors and console.warn/error (originals still run). Returns a stop function. */
  installGlobalHooks(
    target: Window & typeof globalThis = window,
    con: Pick<Console, 'error' | 'warn'> = console,
  ): () => void {
    const onError = (ev: ErrorEvent) =>
      this.log('error', 'window', `${ev.message}${ev.filename ? ` (${ev.filename}:${ev.lineno})` : ''}`);
    const onRejection = (ev: PromiseRejectionEvent) => {
      const r: unknown = ev.reason;
      this.log('error', 'promise', r instanceof Error ? `${r.name}: ${r.message}` : String(r));
    };
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    const origError = con.error;
    const origWarn = con.warn;
    const stringify = (args: unknown[]) =>
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ');
    con.error = (...args: unknown[]) => {
      this.log('error', 'console', stringify(args));
      origError.apply(con, args);
    };
    con.warn = (...args: unknown[]) => {
      this.log('warn', 'console', stringify(args));
      origWarn.apply(con, args);
    };
    const stop = () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
      con.error = origError;
      con.warn = origWarn;
    };
    this.stops.push(stop);
    return stop;
  }

  /** Starts logging engine events. Returns a stop function. */
  attachEngine(
    subscribe: (cb: (e: EngineEvent) => void) => Promise<() => void>,
  ): () => void {
    let un: (() => void) | null = null;
    let stopped = false;
    void subscribe((e) => this.engineEvent(e)).then(
      (u) => (stopped ? u() : (un = u)),
      (err) => this.log('error', 'diagnostics', `engine event subscription failed: ${String(err)}`),
    );
    const stop = () => {
      stopped = true;
      un?.();
    };
    this.stops.push(stop);
    return stop;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** App-wide instance (the log survives navigation). */
export const diagnostics = new Diagnostics();
