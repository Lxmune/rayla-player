import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { flush } from '../../lib/test-support';
import { buildApp } from '../settings/test-app';
import ThemeManager from './ThemeManager.svelte';

const root = document.documentElement;
const accent = () => root.style.getPropertyValue('--accent');

afterEach(() => {
  cleanup();
  for (const a of ['data-theme', 'data-density', 'data-motion']) root.removeAttribute(a);
  root.style.removeProperty('--accent');
  root.style.removeProperty('--accent-contrast');
});

describe('ThemeManager', () => {
  it('applies theme, density and motion attributes', async () => {
    const { app, context } = buildApp();
    render(ThemeManager, { context });
    await flush();
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-density')).toBe('comfortable');
    expect(root.getAttribute('data-motion')).toBe('full');

    await app.core.settings.updateAppearance({ density: 'compact', reduceMotion: true });
    await app.core.settings.setThemeMode('light');
    await flush();
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.getAttribute('data-density')).toBe('compact');
    expect(root.getAttribute('data-motion')).toBe('reduced');
  });

  it('uses the chosen accent when nothing plays and follows changes', async () => {
    const { app, context } = buildApp();
    render(ThemeManager, { context });
    await flush();
    expect(accent()).toBe('#c9a7ff');
    await app.core.settings.updateAppearance({ accentColor: '#ff8800' });
    await flush();
    expect(accent()).toBe('#ff8800');
    expect(root.style.getPropertyValue('--accent-contrast')).toBe('#111111');
  });

  it('adjusts a too-dark chosen accent for the dark theme', async () => {
    const { app, context } = buildApp();
    render(ThemeManager, { context });
    await app.core.settings.updateAppearance({ accentColor: '#102040' });
    await flush();
    expect(accent()).not.toBe('#102040');
    expect(accent()).toMatch(/^#[0-9a-f]{6}$/);
  });
});
