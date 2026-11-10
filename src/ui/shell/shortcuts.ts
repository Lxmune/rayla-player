// Keyboard shortcuts as a pure mapping from a key event to an action id.
// The shell decides whether the event may fire (focus, open sheets) and runs the action.

export type ShortcutAction =
  | 'playPause'
  | 'next'
  | 'previous'
  | 'seekForward'
  | 'seekBack'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute'
  | 'shuffle'
  | 'repeat'
  | 'favorite'
  | 'search'
  | 'back'
  | 'forward'
  | 'queue'
  | 'nowPlaying'
  | 'help';

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function shortcutFor(e: KeyLike): ShortcutAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (e.altKey && !mod && !e.shiftKey) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
    return null;
  }
  if (e.altKey) return null;

  if (mod) {
    if (e.shiftKey) return key === 'f' ? 'nowPlaying' : null;
    switch (key) {
      case 'ArrowRight':
        return 'next';
      case 'ArrowLeft':
        return 'previous';
      case 'ArrowUp':
        return 'volumeUp';
      case 'ArrowDown':
        return 'volumeDown';
      case 'k':
        return 'search';
      default:
        return null;
    }
  }

  if (e.shiftKey) {
    if (key === 'ArrowRight') return 'seekForward';
    if (key === 'ArrowLeft') return 'seekBack';
    if (key === '?') return 'help';
    // Letters with Shift are ordinary typing, except the shifted slash on layouts reporting it.
    return key === '/' ? 'help' : null;
  }

  if (key === ' ' || e.code === 'Space') return 'playPause';
  switch (key) {
    case 'm':
      return 'mute';
    case 's':
      return 'shuffle';
    case 'r':
      return 'repeat';
    case 'l':
      return 'favorite';
    case '/':
      return 'search';
    case 'q':
      return 'queue';
    case 'f':
      return 'nowPlaying';
    case '?':
      return 'help';
    default:
      return null;
  }
}

export interface ShortcutInfo {
  action: ShortcutAction;
  label: string;
  /** Key caps; "Mod" is Ctrl or Cmd depending on the platform. */
  keys: string[][];
}

/** What the shortcuts sheet lists. */
export const SHORTCUTS: ShortcutInfo[] = [
  { action: 'playPause', label: 'Play / pause', keys: [['Space']] },
  { action: 'next', label: 'Next track', keys: [['Mod', '→']] },
  { action: 'previous', label: 'Previous track', keys: [['Mod', '←']] },
  { action: 'seekForward', label: 'Seek forward 10 s', keys: [['Shift', '→']] },
  { action: 'seekBack', label: 'Seek back 10 s', keys: [['Shift', '←']] },
  { action: 'volumeUp', label: 'Volume up', keys: [['Mod', '↑']] },
  { action: 'volumeDown', label: 'Volume down', keys: [['Mod', '↓']] },
  { action: 'mute', label: 'Mute', keys: [['M']] },
  { action: 'shuffle', label: 'Shuffle', keys: [['S']] },
  { action: 'repeat', label: 'Cycle repeat', keys: [['R']] },
  { action: 'favorite', label: 'Favorite current track', keys: [['L']] },
  { action: 'search', label: 'Search', keys: [['Mod', 'K'], ['/']] },
  { action: 'back', label: 'Back', keys: [['Alt', '←']] },
  { action: 'forward', label: 'Forward', keys: [['Alt', '→']] },
  { action: 'queue', label: 'Toggle queue', keys: [['Q']] },
  { action: 'nowPlaying', label: 'Toggle now playing', keys: [['F']] },
  { action: 'help', label: 'Keyboard shortcuts', keys: [['?']] },
];
