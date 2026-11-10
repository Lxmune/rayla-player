import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { flush } from '../../lib/test-support';
import { signedIn, withContext } from '../testing';
import AudioSheet from './AudioSheet.svelte';

afterEach(cleanup);

describe('AudioSheet', () => {
  it('changes quality and effects, and links to the full settings', async () => {
    const { app, engine } = await signedIn();
    const ctx = withContext(app);
    let closed = 0;
    render(AudioSheet, { props: { onclose: () => closed++ }, context: ctx.context });
    expect(screen.getByText('Bit-perfect: nothing alters the signal.')).toBeTruthy();

    await fireEvent.change(screen.getByRole('combobox', { name: /Streaming quality/ }), { target: { value: '192000' } });
    expect(app.core.settings.current.maxBitrate).toBe(192000);

    await fireEvent.click(screen.getByRole('switch', { name: /Compressor/ }));
    await flush();
    expect(app.core.settings.current.dsp.compressor.enabled).toBe(true);
    expect(engine.lastDsp?.compressor.enabled).toBe(true);
    expect(screen.getByRole('slider', { name: /Threshold/ })).toBeTruthy();
    expect(screen.getByText(/compressor is on/)).toBeTruthy();

    ctx.ui.nowPlayingOpen = true;
    await fireEvent.click(screen.getByRole('button', { name: 'All audio settings' }));
    expect(closed).toBe(1);
    expect(ctx.ui.nowPlayingOpen).toBe(false);
    expect(ctx.router.current.name).toBe('settings');
  });
});
