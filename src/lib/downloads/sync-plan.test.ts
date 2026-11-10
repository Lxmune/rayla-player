import { describe, expect, it } from 'vitest';
import { collectionProgress, planSync, type SyncInput } from './sync-plan';

const base: SyncInput = { kept: [], loaded: [], downloaded: new Set(), queued: new Set(), managed: {} };
const input = (o: Partial<SyncInput>): SyncInput => ({ ...base, ...o });

describe('planSync', () => {
  it('downloads missing tracks and claims them', () => {
    const p = planSync(input({ kept: ['A'], loaded: [{ id: 'A', trackIds: ['1', '2', '3'] }], downloaded: new Set(['2']) }));
    expect(p.download).toEqual(['1', '3']);
    expect(p.managed).toEqual({ '1': ['A'], '3': ['A'] });
    expect(p.remove).toEqual([]);
  });

  it('never claims or removes tracks the user downloaded', () => {
    const first = planSync(input({ kept: ['A'], loaded: [{ id: 'A', trackIds: ['2'] }], downloaded: new Set(['2']) }));
    expect(first.managed).toEqual({});
    const later = planSync(input({ kept: ['A'], loaded: [{ id: 'A', trackIds: [] }], downloaded: new Set(['2']), managed: first.managed }));
    expect(later.remove).toEqual([]);
  });

  it('does not queue what is already queued but still claims nothing for user queues', () => {
    const p = planSync(input({ kept: ['A'], loaded: [{ id: 'A', trackIds: ['1'] }], queued: new Set(['1']) }));
    expect(p.download).toEqual([]);
    expect(p.managed).toEqual({});
  });

  it('removes tracks that left a playlist', () => {
    const p = planSync(
      input({
        kept: ['P'],
        loaded: [{ id: 'P', trackIds: ['1'] }],
        downloaded: new Set(['1', '2']),
        managed: { '1': ['P'], '2': ['P'] },
      }),
    );
    expect(p.remove).toEqual(['2']);
    expect(p.managed).toEqual({ '1': ['P'] });
  });

  it('keeps a track another kept collection still needs', () => {
    const p = planSync(
      input({
        kept: ['A', 'P'],
        loaded: [{ id: 'P', trackIds: [] }, { id: 'A', trackIds: ['1'] }],
        downloaded: new Set(['1']),
        managed: { '1': ['P', 'A'] },
      }),
    );
    expect(p.remove).toEqual([]);
    expect(p.managed).toEqual({ '1': ['A'] });
  });

  it('un-keeping a collection releases its tracks', () => {
    const p = planSync(input({ kept: [], downloaded: new Set(['1', '2']), managed: { '1': ['A'], '2': ['A', 'B'] } }));
    expect(p.remove.sort()).toEqual(['1', '2']);
  });

  it('collections that failed to load keep their references', () => {
    const p = planSync(input({ kept: ['A'], loaded: [], downloaded: new Set(['1']), managed: { '1': ['A'] } }));
    expect(p.remove).toEqual([]);
    expect(p.managed).toEqual({ '1': ['A'] });
  });

  it('shared track is downloaded once', () => {
    const p = planSync(input({ kept: ['A', 'B'], loaded: [{ id: 'A', trackIds: ['1'] }, { id: 'B', trackIds: ['1'] }] }));
    expect(p.download).toEqual(['1']);
    expect(p.managed['1']?.sort()).toEqual(['A', 'B']);
  });
});

describe('collectionProgress', () => {
  it('counts downloaded tracks', () => {
    expect(collectionProgress(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual({ have: 2, total: 3 });
  });
});
