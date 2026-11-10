import { describe, expect, it } from 'vitest';
import { HistorySync } from './history-sync';

function fakeWin() {
  const listeners = new Set<() => void>();
  const log: string[] = [];
  const win = {
    history: {
      pushState: () => log.push('push'),
      go: (n: number) => {
        log.push(`go${n}`);
        queueMicrotask(() => listeners.forEach((l) => l()));
      },
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  } as unknown as Window;
  const back = () => listeners.forEach((l) => l());
  return { win, log, back };
}

function setup() {
  let layers = 0;
  const closed: string[] = [];
  const f = fakeWin();
  const sync = new HistorySync(
    {
      layers: () => layers,
      closeTop: () => {
        closed.push('close');
        layers -= 1;
      },
    },
    f.win,
  );
  sync.attach();
  const set = (n: number) => {
    layers = n;
    sync.update(n);
  };
  return { ...f, closed, set, sync };
}

describe('HistorySync', () => {
  it('pushes one entry per new layer', () => {
    const s = setup();
    s.set(2);
    expect(s.log).toEqual(['push', 'push']);
  });

  it('closes the top layer on system back without touching history', () => {
    const s = setup();
    s.set(2);
    s.back();
    expect(s.closed).toEqual(['close']);
    expect(s.log).toEqual(['push', 'push']);
    s.back();
    expect(s.closed).toHaveLength(2);
  });

  it('ignores popstate when no layer is open (lets the app exit)', () => {
    const s = setup();
    s.back();
    expect(s.closed).toEqual([]);
  });

  it('unwinds entries when layers close in-app and does not close again', async () => {
    const s = setup();
    s.set(3);
    s.set(1);
    expect(s.log.at(-1)).toBe('go-2');
    await Promise.resolve();
    expect(s.closed).toEqual([]);
  });

  it('waits for an in-flight traversal before pushing again', async () => {
    const s = setup();
    s.set(2);
    s.set(0);
    s.set(1);
    expect(s.log).toEqual(['push', 'push', 'go-2']);
    await Promise.resolve();
    expect(s.log).toEqual(['push', 'push', 'go-2', 'push']);
  });
});
