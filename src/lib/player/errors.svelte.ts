import { diagnostics } from '../diagnostics.svelte';

// The most recent engine failure (failed call or `error` event). The shell
// shows it as a dismissible, non-fatal banner.

/** Text of whatever a failed call threw (Tauri rejects with plain strings). */
export function errorMessage(error: unknown): string {
  let message: string;
  if (typeof error === 'string') message = error;
  else if (error instanceof Error) message = error.message;
  else message = String(error);
  return message.replace(/^(Error|Exception): /, '');
}

export class EngineErrors {
  /** Null when there is nothing to show. */
  message = $state<string | null>(null);

  report(error: unknown): void {
    this.message = errorMessage(error);
    diagnostics.log('error', 'engine-errors', this.message);
  }

  clear(): void {
    this.message = null;
  }

  /** Runs an engine call, turning a failure into a reported error. */
  async guard(call: () => Promise<unknown>): Promise<void> {
    try {
      await call();
    } catch (e) {
      this.report(e);
    }
  }
}
