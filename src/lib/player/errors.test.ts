import { describe, expect, it } from 'vitest';
import { EngineErrors, errorMessage } from './errors.svelte';

describe('EngineErrors', () => {
  it('reports strings and errors, stripping Exception/Error prefixes', () => {
    const e = new EngineErrors();
    e.report('Exception: boom');
    expect(e.message).toBe('boom');
    e.report(new Error('bad'));
    expect(e.message).toBe('bad');
    e.report(42);
    expect(e.message).toBe('42');
    e.clear();
    expect(e.message).toBeNull();
    expect(errorMessage('Error: x')).toBe('x');
  });

  it('guard turns a failing call into a reported error', async () => {
    const e = new EngineErrors();
    await e.guard(async () => {});
    expect(e.message).toBeNull();
    await e.guard(async () => {
      throw 'device lost';
    });
    expect(e.message).toBe('device lost');
  });
});
