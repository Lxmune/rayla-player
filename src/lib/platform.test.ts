import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { memoryKv } from './platform';
import App from '../App.svelte';

describe('memoryKv', () => {
  it('stores and deletes values', () => {
    const kv = memoryKv();
    kv.set('a', '1');
    expect(kv.get('a')).toBe('1');
    kv.set('a', null);
    expect(kv.get('a')).toBeNull();
  });
});

describe('component rendering', () => {
  it('mounts a Svelte component under jsdom', () => {
    const { getByText } = render(App);
    expect(getByText('Rayla')).toBeTruthy();
  });
});
