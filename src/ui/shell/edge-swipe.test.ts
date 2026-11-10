import { describe, expect, it } from 'vitest';
import { classifyEdgeDrag, decideEdgeRelease, edgeOffset, nextBackStep, startsAtEdge } from './edge-swipe';

describe('edge swipe', () => {
  it('only edge starts count', () => {
    expect(startsAtEdge(10)).toBe(true);
    expect(startsAtEdge(40)).toBe(false);
    expect(startsAtEdge(110, 100)).toBe(true);
  });
  it('classifies drags', () => {
    expect(classifyEdgeDrag(3, 2)).toBe('none');
    expect(classifyEdgeDrag(30, 5)).toBe('swipe');
    expect(classifyEdgeDrag(30, 30)).toBe('cancel');
    expect(classifyEdgeDrag(-30, 0)).toBe('cancel');
  });
  it('clamps offset', () => {
    expect(edgeOffset(-5, 300)).toBe(0);
    expect(edgeOffset(400, 300)).toBe(300);
  });
  it('commits on distance or flick', () => {
    expect(decideEdgeRelease(50, 0, 400)).toBe('cancel');
    expect(decideEdgeRelease(150, 0, 400)).toBe('commit');
    expect(decideEdgeRelease(40, 0.8, 400)).toBe('commit');
    expect(decideEdgeRelease(5, 0.8, 400)).toBe('cancel');
  });
  it('back order', () => {
    const o = { menu: true, sheet: true, nowPlaying: true, queue: true };
    expect(nextBackStep(o)).toBe('menu');
    expect(nextBackStep({ ...o, menu: false })).toBe('sheet');
    expect(nextBackStep({ ...o, menu: false, sheet: false })).toBe('nowPlaying');
    expect(nextBackStep({ ...o, menu: false, sheet: false, nowPlaying: false })).toBe('queue');
    expect(nextBackStep({ menu: false, sheet: false, nowPlaying: false, queue: false })).toBe('route');
  });
});
