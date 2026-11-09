/** Credential store (OS keychain via `ipc.secretGet/secretSet`; fakes in tests). */
export interface Secrets {
  get(key: string): Promise<string | null>;
  /** null or empty deletes. */
  set(key: string, value: string | null): Promise<void>;
}

export function memorySecrets(): Secrets & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (k) => values.get(k) ?? null,
    set: async (k, v) => {
      if (v === null || v === '') values.delete(k);
      else values.set(k, v);
    },
  };
}
