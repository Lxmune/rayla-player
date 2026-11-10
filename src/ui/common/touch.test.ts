import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBaseItem } from '../../lib/jellyfin/models';
import { flush, trackJson } from '../../lib/test-support';
import { signedIn, withContext } from '../testing';
import Card from './Card.svelte';
import ContextMenu from './ContextMenu.svelte';
import Sheet from './Sheet.svelte';
import { createRawSnippet } from 'svelte';
import TrackRow from './TrackRow.svelte';
import { decideAxis, exceedsSlop, shouldDismiss, sheetOffset, swipeCommit, swipeOffset } from './touch';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ptr(el: Element, type: string, x: number, y: number, pointerType = 'touch') {
  el.dispatchEvent(
    new PointerEvent(type, { pointerType, pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }),
  );
}

describe('gesture helpers', () => {
  it('decides scroll vs swipe after a few px', () => {
    expect(decideAxis(3, 2)).toBe('pending');
    expect(decideAxis(12, 3)).toBe('horizontal');
    expect(decideAxis(-12, 4)).toBe('horizontal');
    expect(decideAxis(4, 14)).toBe('vertical');
    expect(decideAxis(10, 10)).toBe('vertical');
  });

  it('long-press slop', () => {
    expect(exceedsSlop(3, 4)).toBe(false);
    expect(exceedsSlop(9, 9)).toBe(true);
  });

  it('swipe commit threshold and resistance', () => {
    expect(swipeCommit(50, 300)).toBeNull();
    expect(swipeCommit(100, 300)).toBe('right');
    expect(swipeCommit(-100, 300)).toBe('left');
    expect(swipeOffset(60, 300)).toBe(60);
    expect(swipeOffset(200, 300)).toBeLessThan(200);
    expect(swipeOffset(-1000, 300)).toBe(-180);
  });

  it('bottom-sheet dismiss: far drag or flick down, never upward', () => {
    expect(shouldDismiss(50, 0.1, 400)).toBe(false);
    expect(shouldDismiss(180, 0.1, 400)).toBe(true);
    expect(shouldDismiss(40, 0.9, 400)).toBe(true);
    expect(shouldDismiss(10, 0.9, 400)).toBe(false);
    expect(shouldDismiss(-200, 2, 400)).toBe(false);
    expect(sheetOffset(30)).toBe(30);
    expect(sheetOffset(-300)).toBe(-24);
  });
});

describe('Card long-press', () => {
  const album = parseBaseItem({ Id: 'al1', Name: 'Great Album', Type: 'MusicAlbum', AlbumArtist: 'Artist' });

  async function setup() {
    const { app } = await signedIn();
    const ctx = withContext(app);
    let opened = 0;
    const view = render(Card, { props: { item: album, onclick: () => opened++ }, context: ctx.context });
    vi.useFakeTimers();
    const card = view.container.querySelector('.card')!;
    return { card, ctx, opened: () => opened };
  }

  it('opens the item menu after 450 ms and swallows the click', async () => {
    const { card, ctx, opened } = await setup();
    ptr(card, 'pointerdown', 20, 20);
    vi.advanceTimersByTime(400);
    expect(ctx.ui.menu).toBeNull();
    vi.advanceTimersByTime(60);
    expect(ctx.ui.menu).not.toBeNull();
    expect(ctx.ui.menu!.entries.length).toBeGreaterThan(3);
    ptr(card, 'pointerup', 20, 20);
    screen.getByText('Great Album').closest('button')!.click();
    expect(opened()).toBe(0);
    // A later, genuine tap works again.
    vi.advanceTimersByTime(1000);
    screen.getByText('Great Album').closest('button')!.click();
    expect(opened()).toBe(1);
  });

  it('is cancelled by finger movement or lifting early', async () => {
    const { card, ctx } = await setup();
    ptr(card, 'pointerdown', 20, 20);
    ptr(card, 'pointermove', 20, 40);
    vi.advanceTimersByTime(600);
    expect(ctx.ui.menu).toBeNull();
    ptr(card, 'pointerdown', 20, 20);
    vi.advanceTimersByTime(200);
    ptr(card, 'pointerup', 20, 20);
    vi.advanceTimersByTime(600);
    expect(ctx.ui.menu).toBeNull();
  });

  it('ignores mouse presses and dedupes the native contextmenu event', async () => {
    const { card, ctx } = await setup();
    ptr(card, 'pointerdown', 20, 20, 'mouse');
    vi.advanceTimersByTime(600);
    expect(ctx.ui.menu).toBeNull();

    ptr(card, 'pointerdown', 20, 20);
    vi.advanceTimersByTime(460);
    const first = ctx.ui.menu;
    expect(first).not.toBeNull();
    const ev = new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true, cancelable: true });
    card.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(ctx.ui.menu).toBe(first);
  });
});

describe('TrackRow swipe', () => {
  const track = parseBaseItem(trackJson('t1', 'First Song'));

  async function setup() {
    const { app } = await signedIn();
    const ctx = withContext(app);
    const view = render(TrackRow, { props: { track, onplay: () => {} }, context: ctx.context });
    return { swipe: view.container.querySelector('.swipe')!, ctx, app };
  }

  it('swipe right queues play-next, swipe left adds to the queue', async () => {
    const { swipe, ctx } = await setup();
    ptr(swipe, 'pointerdown', 10, 10);
    ptr(swipe, 'pointermove', 60, 12);
    ptr(swipe, 'pointermove', 200, 12);
    expect(swipe.getAttribute('data-armed')).not.toBeNull();
    ptr(swipe, 'pointerup', 200, 12);
    await flush();
    expect(ctx.ui.toasts.map((t) => t.message).join()).toContain('will play next');

    ptr(swipe, 'pointerdown', 250, 10);
    ptr(swipe, 'pointermove', 200, 12);
    ptr(swipe, 'pointermove', 80, 12);
    ptr(swipe, 'pointerup', 80, 12);
    await flush();
    expect(ctx.ui.toasts.map((t) => t.message).join()).toContain('to the queue');
  });

  it('short or vertical drags do nothing', async () => {
    const { swipe, ctx } = await setup();
    ptr(swipe, 'pointerdown', 10, 10);
    ptr(swipe, 'pointermove', 60, 12);
    ptr(swipe, 'pointerup', 60, 12);
    ptr(swipe, 'pointerdown', 10, 10);
    ptr(swipe, 'pointermove', 14, 60);
    ptr(swipe, 'pointermove', 200, 70);
    ptr(swipe, 'pointerup', 200, 70);
    await flush();
    expect(ctx.ui.toasts).toHaveLength(0);
  });

  it('long-press on a row opens its menu', async () => {
    const { swipe, ctx } = await setup();
    vi.useFakeTimers();
    ptr(swipe, 'pointerdown', 10, 10);
    vi.advanceTimersByTime(460);
    expect(ctx.ui.menu).not.toBeNull();
  });
});

describe('Sheet', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-motion');
  });

  it('is a named modal dialog and closes on Escape', async () => {
    let closed = 0;
    const body = createRawSnippet(() => ({ render: () => '<p>Hello</p>' }));
    render(Sheet, { props: { title: 'Things', onclose: () => closed++, children: body } });
    expect(screen.getByRole('dialog', { name: 'Things' })).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(1);
  });
});

describe('ContextMenu', () => {
  it('lists entries and runs the chosen one, closing first', async () => {
    const { app } = await signedIn();
    const ctx = withContext(app);
    render(ContextMenu, { context: ctx.context });
    let ran = 0;
    ctx.ui.openMenu({ x: 5, y: 5 }, [{ label: 'Do it', onselect: () => ran++ }]);
    const item = await screen.findByRole('menuitem', { name: 'Do it' });
    item.click();
    expect(ran).toBe(1);
    expect(ctx.ui.menu).toBeNull();
  });
});
