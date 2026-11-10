import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { SignalPath } from '../../lib/ipc';
import { flush, track } from '../../lib/test-support';
import { buildApp } from '../settings/test-app';
import SignalPathSheet from './SignalPathSheet.svelte';
import TechInfoSheet from './TechInfoSheet.svelte';

const path = (over: Partial<SignalPath> = {}): SignalPath => ({
  codec: 'flac',
  sourceSampleRate: 96000,
  sourceBitDepth: 24,
  channels: 2,
  stages: [],
  deviceName: 'My DAC',
  outputSampleRate: 96000,
  outputBitDepth: 24,
  exclusive: true,
  bitPerfect: true,
  ...over,
});

async function play(over: Partial<SignalPath>) {
  const b = buildApp();
  await b.ready();
  await b.app.core.player.playQueue([track('a')]);
  b.engine.emit({
    kind: 'signalPathChanged', state: 'playing', trackId: 'a', entryId: null,
    positionMs: 0, durationMs: 0, signalPath: path(over), message: null, throughputBps: 0,
  });
  b.engine.trackStarted('a');
  await flush();
  return b;
}

afterEach(cleanup);

describe('SignalPathSheet', () => {
  it('shows an empty state when nothing plays', () => {
    const { context } = buildApp();
    render(SignalPathSheet, { context });
    expect(screen.getByText('Nothing is playing.')).toBeTruthy();
    expect(screen.queryByTestId('bit-perfect')).toBeNull();
  });

  it('renders source, stages, output and the bit-perfect badge', async () => {
    const { context, app } = await play({});
    render(SignalPathSheet, { context });
    expect(app.core.player.signalPath).not.toBeNull();
    expect(screen.getByText('FLAC')).toBeTruthy();
    expect(screen.getByText('24-bit / 96 kHz · 2 ch')).toBeTruthy();
    expect(screen.getByText('My DAC')).toBeTruthy();
    expect(screen.getByText('24-bit / 96 kHz · Exclusive')).toBeTruthy();
    expect(screen.getByTestId('bit-perfect').textContent).toBe('Bit-perfect');
  });

  it('lists active stages and hides the badge when not bit-perfect', async () => {
    const { context } = await play({ stages: ['ReplayGain -6.2 dB', 'Parametric EQ'], bitPerfect: false, exclusive: false });
    render(SignalPathSheet, { context });
    expect(screen.getByText('ReplayGain -6.2 dB')).toBeTruthy();
    expect(screen.getByText('Parametric EQ')).toBeTruthy();
    expect(screen.getByText('24-bit / 96 kHz · Shared')).toBeTruthy();
    expect(screen.queryByTestId('bit-perfect')).toBeNull();
  });
});

describe('TechInfoSheet', () => {
  it('renders the Jellyfin rows', () => {
    const { context } = buildApp();
    render(TechInfoSheet, { props: { item: track('a') }, context });
    expect(screen.getByRole('rowheader', { name: 'Container' })).toBeTruthy();
    expect(screen.getAllByText('FLAC', { selector: 'td' }).length).toBeGreaterThan(0);
    expect(screen.getByText('96 kHz')).toBeTruthy();
    expect(screen.getByText('Original file')).toBeTruthy();
    expect(screen.queryByText('Output device')).toBeNull();
  });

  it('adds live signal path rows for the current track', async () => {
    const { context } = await play({});
    render(TechInfoSheet, { props: { item: track('a') }, context });
    expect(screen.getByText('Output device')).toBeTruthy();
    expect(screen.getByText('My DAC')).toBeTruthy();
    expect(screen.getByText('Bit-perfect', { selector: 'th' })).toBeTruthy();
  });
});
