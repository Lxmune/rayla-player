import { describe, expect, it } from 'vitest';
import { shortcutFor, type KeyLike } from './shortcuts';

const ev = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('shortcutFor', () => {
  it('maps plain keys', () => {
    expect(shortcutFor(ev(' ', { code: 'Space' }))).toBe('playPause');
    expect(shortcutFor(ev('m'))).toBe('mute');
    expect(shortcutFor(ev('S'))).toBe('shuffle');
    expect(shortcutFor(ev('r'))).toBe('repeat');
    expect(shortcutFor(ev('l'))).toBe('favorite');
    expect(shortcutFor(ev('q'))).toBe('queue');
    expect(shortcutFor(ev('f'))).toBe('nowPlaying');
    expect(shortcutFor(ev('/'))).toBe('search');
    expect(shortcutFor(ev('x'))).toBeNull();
  });

  it('maps modifier combinations for Ctrl and Cmd', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(shortcutFor(ev('ArrowRight', mod))).toBe('next');
      expect(shortcutFor(ev('ArrowLeft', mod))).toBe('previous');
      expect(shortcutFor(ev('ArrowUp', mod))).toBe('volumeUp');
      expect(shortcutFor(ev('ArrowDown', mod))).toBe('volumeDown');
      expect(shortcutFor(ev('k', mod))).toBe('search');
      expect(shortcutFor(ev('F', { ...mod, shiftKey: true }))).toBe('nowPlaying');
      expect(shortcutFor(ev('f', mod))).toBeNull();
    }
  });

  it('maps seek, history and help', () => {
    expect(shortcutFor(ev('ArrowRight', { shiftKey: true }))).toBe('seekForward');
    expect(shortcutFor(ev('ArrowLeft', { shiftKey: true }))).toBe('seekBack');
    expect(shortcutFor(ev('ArrowLeft', { altKey: true }))).toBe('back');
    expect(shortcutFor(ev('ArrowRight', { altKey: true }))).toBe('forward');
    expect(shortcutFor(ev('?', { shiftKey: true }))).toBe('help');
  });

  it('ignores Space with a modifier', () => {
    expect(shortcutFor(ev(' ', { code: 'Space', ctrlKey: true }))).toBeNull();
    expect(shortcutFor(ev(' ', { code: 'Space', altKey: true }))).toBeNull();
  });
});
