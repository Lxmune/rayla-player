import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputDevice } from '../../lib/ipc';
import { buildApp, withContext } from '../testing';
import OutputSheet from './OutputSheet.svelte';

const devices: OutputDevice[] = [
  { id: 'd1', name: 'Speakers', isDefault: true, supportsExclusive: false, sampleRates: [44100, 48000], maxBitDepth: 16 },
  { id: 'd2', name: 'USB DAC', isDefault: false, supportsExclusive: true, sampleRates: [44100, 192000], maxBitDepth: 32 },
];

const mocks = vi.hoisted(() => {
  const state: { cb: (() => void) | null; unsub: ReturnType<typeof vi.fn> } = { cb: null, unsub: vi.fn() };
  return {
    state,
    list: vi.fn(),
    onChanged: vi.fn(async (cb: () => void) => {
      state.cb = cb;
      return state.unsub;
    }),
  };
});

vi.mock('../../lib/outputs', () => ({
  listOutputDevices: mocks.list,
  onOutputDevicesChanged: mocks.onChanged,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(devices);
});
afterEach(cleanup);

describe('OutputSheet', () => {
  it('lists the default and every device, marking the current one', async () => {
    const { app } = buildApp();
    render(OutputSheet, { context: withContext(app).context });
    await screen.findByText('USB DAC');
    const def = screen.getByRole('button', { name: /System default/ });
    expect(def.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByText('Speakers').length).toBeGreaterThan(0);
    expect(screen.getByText(/exclusive capable/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /USB DAC/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('applies a selection live and toggles exclusive', async () => {
    const { app, engine } = buildApp();
    render(OutputSheet, { context: withContext(app).context });
    await fireEvent.click(await screen.findByRole('button', { name: /USB DAC/ }));
    await waitFor(() => expect(app.core.settings.current.outputDeviceId).toBe('d2'));
    expect(screen.getByRole('button', { name: /USB DAC/ }).getAttribute('aria-pressed')).toBe('true');
    const sw = screen.getByRole('switch', { name: /Exclusive mode/ }) as HTMLInputElement;
    expect(sw.disabled).toBe(false);
    await fireEvent.click(sw);
    expect(app.core.settings.current.exclusive).toBe(true);
    expect(engine.calls).toContain('setOutput(d2,true)');
  });

  it('disables exclusive when the device cannot do it', async () => {
    const { app } = buildApp();
    render(OutputSheet, { context: withContext(app).context });
    await screen.findByText('USB DAC');
    expect((screen.getByRole('switch', { name: /Exclusive mode/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it('shows a missing selected device as disconnected', async () => {
    const { app } = buildApp();
    await app.core.settings.setOutput('gone', false);
    render(OutputSheet, { context: withContext(app).context });
    await screen.findByText('Disconnected');
    expect(app.core.settings.current.outputDeviceId).toBe('gone');
  });

  it('refreshes on device changes and unsubscribes on destroy', async () => {
    const { app } = buildApp();
    const { unmount } = render(OutputSheet, { context: withContext(app).context });
    await screen.findByText('USB DAC');
    mocks.list.mockResolvedValue([...devices, { ...devices[1], id: 'd3', name: 'Galaxy Buds' }]);
    mocks.state.cb?.();
    await screen.findByText('Galaxy Buds');
    unmount();
    await waitFor(() => expect(mocks.state.unsub).toHaveBeenCalled());
  });

  it('shows an error when listing fails and an empty note', async () => {
    mocks.list.mockRejectedValue(new Error('boom'));
    const { app } = buildApp();
    render(OutputSheet, { context: withContext(app).context });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mocks.list.mockResolvedValue([]);
    render(OutputSheet, { context: withContext(app).context });
    expect(await screen.findByText('No audio devices found.')).toBeTruthy();
  });
});
