import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputDevice } from '../../lib/ipc';
import { fakeFetch } from '../../lib/integrations/test-helpers';
import { flush } from '../../lib/test-support';
import SettingsScreen from './SettingsScreen.svelte';
import { buildApp } from './test-app';

const devices: OutputDevice[] = [
  { id: 'd1', name: 'Speakers', isDefault: true, supportsExclusive: false, sampleRates: [44100, 48000], maxBitDepth: 16 },
  { id: 'd2', name: 'DAC', isDefault: false, supportsExclusive: true, sampleRates: [44100, 192000], maxBitDepth: 32 },
];

vi.mock('../../lib/ipc', async (orig) => {
  const mod = await orig<typeof import('../../lib/ipc')>();
  return { ...mod, ipc: { ...mod.ipc, listDevices: vi.fn(async () => devices) } };
});

beforeEach(() => vi.clearAllMocks());

afterEach(cleanup);

describe('SettingsScreen', () => {
  it('ReplayGain and EQ toggles update settings and the engine', async () => {
    const { app, engine, context } = buildApp();
    render(SettingsScreen, { context });
    await fireEvent.change(screen.getByLabelText('ReplayGain'), { target: { value: 'album' } });
    expect(app.core.settings.current.dsp.replayGain).toBe('album');
    expect(engine.lastDsp?.replayGain).toBe('album');
    await fireEvent.click(screen.getByRole('switch', { name: /Enable EQ/ }));
    expect(app.core.settings.current.dsp.eqEnabled).toBe(true);
    expect(engine.lastDsp?.eqEnabled).toBe(true);
  });

  it('shows whether the config is bit-perfect', async () => {
    const { context } = buildApp();
    render(SettingsScreen, { context });
    expect(screen.getByText('Current settings are bit-perfect')).toBeTruthy();
    await fireEvent.change(screen.getByLabelText('Crossfeed'), { target: { value: 'low' } });
    expect(screen.getByText('Not bit-perfect')).toBeTruthy();
    expect(screen.getByText('Crossfeed is on')).toBeTruthy();
  });

  it('lists devices and enables exclusive only when supported', async () => {
    const { app, context } = buildApp();
    render(SettingsScreen, { context });
    await screen.findByText('DAC');
    const excl = screen.getByRole('switch', { name: /Exclusive mode/ }) as HTMLInputElement;
    expect(excl.disabled).toBe(true);
    await fireEvent.click(screen.getByRole('radio', { name: /DAC/ }));
    expect(app.core.settings.current.outputDeviceId).toBe('d2');
    expect(excl.disabled).toBe(false);
    await fireEvent.click(excl);
    expect(app.core.settings.current.exclusive).toBe(true);
  });

  it('bitrate cap writes bits per second', async () => {
    const { app, context } = buildApp();
    render(SettingsScreen, { context });
    await fireEvent.change(screen.getByLabelText(/Bitrate cap/), { target: { value: '320000' } });
    expect(app.core.settings.current.maxBitrate).toBe(320000);
  });

  it('AutoEQ import replaces bands and preamp and reports skipped lines', async () => {
    const { app, engine, context } = buildApp();
    await app.core.settings.updateDsp({ eqBands: [{ kind: 'peak', freqHz: 50, gainDb: 1, q: 1 }] });
    render(SettingsScreen, { context });
    const text = 'Preamp: -6.2 dB\nFilter 1: ON PK Fc 105 Hz Gain -3.1 dB Q 0.70\nFilter 2: ON LSC Fc 20 Hz Gain 2 dB\nbogus line';
    const file = new File([text], 'eq.txt', { type: 'text/plain' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(app.core.settings.current.dsp.eqBands).toHaveLength(2));
    const dsp = app.core.settings.current.dsp;
    expect(dsp.eqPreampDb).toBe(-6.2);
    expect(dsp.eqBands[0]).toMatchObject({ kind: 'peak', freqHz: 105, gainDb: -3.1, q: 0.7 });
    expect(engine.lastDsp?.eqBands).toHaveLength(2);
    expect(await screen.findByText('1 lines skipped')).toBeTruthy();
  });

  it('AutoEQ import shows format errors and keeps the bands', async () => {
    const { app, context } = buildApp();
    render(SettingsScreen, { context });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await fireEvent.change(input, { target: { files: [new File(['nothing'], 'x.txt')] } });
    expect(await screen.findByText(/No enabled filters/)).toBeTruthy();
    expect(app.core.settings.current.dsp.eqBands).toEqual([]);
  });

  it('adds, edits and removes EQ bands', async () => {
    const { app, context } = buildApp();
    render(SettingsScreen, { context });
    await fireEvent.click(screen.getByRole('button', { name: 'Add band' }));
    await fireEvent.change(screen.getByLabelText('Band 1 frequency (Hz)'), { target: { value: '250' } });
    expect(app.core.settings.current.dsp.eqBands[0]?.freqHz).toBe(250);
    await fireEvent.click(screen.getByRole('button', { name: 'Remove band 1' }));
    expect(app.core.settings.current.dsp.eqBands).toEqual([]);
  });

  it('Last.fm login stores the session, never the password', async () => {
    const f = fakeFetch(() => [200, '{"session":{"key":"SK"}}']);
    const { app, secrets, context } = buildApp({ fetch: f.fn });
    await app.credentials.setLastFmApp('key', 'sec');
    render(SettingsScreen, { context });
    await fireEvent.input(screen.getByLabelText('Last.fm username'), { target: { value: 'ann' } });
    await fireEvent.input(screen.getByLabelText('Last.fm password'), { target: { value: 'hunter2' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await screen.findByText('Signed in as ann');
    expect(app.credentials.lastFmSessionKey).toBe('SK');
    expect([...secrets.store.values()]).not.toContain('hunter2');
    expect(JSON.stringify(app.core.settings.current)).not.toContain('hunter2');
    await fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(app.credentials.hasLastFmSession).toBe(false));
  });

  it('stores the ListenBrainz token on change', async () => {
    const { app, context } = buildApp();
    render(SettingsScreen, { context });
    await fireEvent.change(screen.getByLabelText('ListenBrainz user token'), { target: { value: ' tok ' } });
    await flush();
    expect(app.credentials.listenBrainzToken).toBe('tok');
  });

  it('Discord edits update settings; placeholder id warns', async () => {
    const { app, context } = buildApp();
    render(SettingsScreen, { context });
    expect(screen.getByText(/placeholder Application ID/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('switch', { name: /Show what I'm playing/ }));
    await fireEvent.change(screen.getByLabelText('Application ID'), { target: { value: '123456789012345678' } });
    await fireEvent.change(screen.getByLabelText('Details (first line)'), { target: { value: '{title} by {artist}' } });
    await fireEvent.change(screen.getByLabelText('Button 2 label'), { target: { value: 'Listen' } });
    await fireEvent.change(screen.getByLabelText('Button 2 URL'), { target: { value: 'https://x.test/{id}' } });
    const d = app.core.settings.current.discord;
    expect(d.enabled).toBe(true);
    expect(d.applicationId).toBe('123456789012345678');
    expect(d.details).toBe('{title} by {artist}');
    expect(d.buttons[1]).toEqual({ label: 'Listen', url: 'https://x.test/{id}' });
    expect(d.buttons[0]).toEqual({ label: '', url: '' });
    expect(screen.queryByText(/placeholder Application ID/)).toBeNull();
  });
});

describe('SettingsScreen appearance, behavior and navigation', () => {
  it('theme, accent, density and toggles write the appearance settings', async () => {
    const { app, context } = buildApp();
    render(SettingsScreen, { context });
    const s = () => app.core.settings.current;
    await fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(s().themeMode).toBe('light');
    await fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(s().appearance.density).toBe('compact');
    await fireEvent.click(screen.getByRole('button', { name: 'Mint' }));
    expect(s().appearance.accentColor).toBe('#6bd6a8');
    expect(screen.getByRole('button', { name: 'Mint' }).getAttribute('aria-pressed')).toBe('true');
    await fireEvent.change(screen.getByLabelText('Custom accent colour'), { target: { value: '#112233' } });
    expect(s().appearance.accentColor).toBe('#112233');
    await fireEvent.click(screen.getByRole('switch', { name: /Accent colour from cover art/ }));
    expect(s().appearance.accentFromCover).toBe(false);
    await fireEvent.click(screen.getByRole('switch', { name: /Art backdrops/ }));
    expect(s().appearance.artBackdrop).toBe(false);
    await fireEvent.click(screen.getByRole('switch', { name: /Reduce motion/ }));
    expect(s().appearance.reduceMotion).toBe(true);
  });

  it('behavior toggles resume and start screen', async () => {
    const { app, context } = buildApp();
    render(SettingsScreen, { context });
    await fireEvent.click(screen.getByRole('switch', { name: /Resume where I left off/ }));
    expect(app.core.settings.current.behavior.resumePlayback).toBe(false);
    await fireEvent.change(screen.getByLabelText(/Start screen/), { target: { value: 'albums' } });
    expect(app.core.settings.current.behavior.startScreen).toBe('albums');
  });

  it('search filters sections and the categories list', async () => {
    const { context } = buildApp();
    render(SettingsScreen, { context });
    expect(screen.getByText('Press', { exact: false })).toBeTruthy();
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'dither' } });
    expect(screen.getByRole('heading', { name: 'Processing' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Appearance' })).toBeNull();
    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/No settings match/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
  });

  it('shows the app version in About', () => {
    const { context } = buildApp();
    render(SettingsScreen, { context });
    expect(screen.getByText(/^Version \d/)).toBeTruthy();
  });
});
