import { describe, expect, it } from 'vitest';
import {
  ScrollMemory, VelocityTracker, WheelSwipe, coverDragOffset, decideCoverDrag, decideRelease, decideSkip, nextChipsHidden, pastThreshold,
  pullState, resist, sheetDragStyle, shouldStartPull,
} from './gestures';

describe('gestures', () => {
  it('decideRelease uses distance or velocity', () => {
    expect(decideRelease(100, 0, 800)).toBe('cancel');
    expect(decideRelease(200, 0, 800)).toBe('commit');
    expect(decideRelease(40, 0.9, 800)).toBe('commit');
    expect(decideRelease(-50, 2, 800)).toBe('cancel');
    expect(pastThreshold(200, 800)).toBe(true);
    expect(pastThreshold(100, 800)).toBe(false);
  });
  it('sheetDragStyle follows and clamps', () => {
    expect(sheetDragStyle(-10, 800)).toEqual({ y: 0, scale: 1, opacity: 1 });
    const s = sheetDragStyle(400, 800);
    expect(s.y).toBe(400);
    expect(s.scale).toBeLessThan(1);
    expect(s.opacity).toBeLessThan(1);
  });
  it('pull to refresh resists and triggers', () => {
    expect(resist(-5)).toBe(0);
    expect(resist(1000)).toBeLessThan(120);
    expect(pullState(20).armed).toBe(false);
    expect(pullState(300).armed).toBe(true);
    expect(shouldStartPull(0, 2, 20)).toBe(true);
    expect(shouldStartPull(30, 2, 20)).toBe(false);
    expect(shouldStartPull(0, 40, 20)).toBe(false);
    expect(shouldStartPull(0, 0, -20)).toBe(false);
  });
  it('decideSkip', () => {
    expect(decideSkip(-200, 0, 360)).toBe('next');
    expect(decideSkip(200, 0, 360)).toBe('previous');
    expect(decideSkip(-30, 0, 360)).toBe('cancel');
    expect(decideSkip(-30, 1, 360)).toBe('next');
  });
  it('VelocityTracker', () => {
    const v = new VelocityTracker();
    v.add(0, 0);
    v.add(100, 50);
    expect(v.get()).toBeCloseTo(0.5);
    v.reset();
    expect(v.get()).toBe(0);
  });
  it('ScrollMemory', () => {
    const m = new ScrollMemory();
    m.save(1, 300);
    m.save(2, 50);
    expect(m.take(1)).toBe(300);
    m.clearFrom(2);
    expect(m.take(2)).toBe(0);
  });
  it('nextChipsHidden', () => {
    expect(nextChipsHidden(0, 50, false)).toBe(true);
    expect(nextChipsHidden(50, 40, true)).toBe(false);
    expect(nextChipsHidden(50, 52, true)).toBe(true);
    expect(nextChipsHidden(10, 0, true)).toBe(false);
  });
  it('coverDragOffset follows then resists', () => {
    expect(coverDragOffset(50, 300)).toBe(50);
    expect(coverDragOffset(-50, 300)).toBe(-50);
    expect(coverDragOffset(400, 300)).toBeLessThanOrEqual(180);
    expect(coverDragOffset(200, 300)).toBeLessThan(200);
    expect(coverDragOffset(10, 0)).toBe(0);
  });
  it('decideCoverDrag', () => {
    expect(decideCoverDrag(20, 2, 'mouse')).toBe('h');
    expect(decideCoverDrag(2, 20, 'touch')).toBe('v');
    expect(decideCoverDrag(2, 20, 'mouse')).toBe('cancel');
    expect(decideCoverDrag(2, -20, 'touch')).toBe('cancel');
    expect(decideCoverDrag(3, 3, 'touch')).toBe('none');
  });
  it('WheelSwipe: one gesture, one skip', () => {
    const w = new WheelSwipe(90, 600, 150);
    expect(w.add(40, 2, 0)).toBeNull();
    expect(w.add(40, 2, 20)).toBeNull();
    expect(w.add(40, 2, 40)).toBe('next');
    expect(w.add(80, 0, 100)).toBeNull(); // inertia tail
    expect(w.add(-120, 0, 1000)).toBe('previous');
    expect(w.add(5, 50, 2000)).toBeNull(); // vertical scroll
  });
});

import {
  carouselOffset, carouselProgress, decideCarousel, neighbourIndices, peekDirection, settleDuration, settleTarget,
} from './gestures';

describe('carousel maths', () => {
  it('neighbours follow the controller (repeat all wraps)', () => {
    expect(neighbourIndices(1, 3, 'off')).toEqual({ previous: 0, next: 2 });
    expect(neighbourIndices(0, 3, 'off')).toEqual({ previous: null, next: 1 });
    expect(neighbourIndices(2, 3, 'off')).toEqual({ previous: 1, next: null });
    expect(neighbourIndices(2, 3, 'all')).toEqual({ previous: 1, next: 0 });
    expect(neighbourIndices(0, 3, 'all')).toEqual({ previous: 2, next: 1 });
    expect(neighbourIndices(0, 1, 'all')).toEqual({ previous: null, next: null });
    expect(neighbourIndices(-1, 0, 'off')).toEqual({ previous: null, next: null });
  });
  it('dragging left peeks next, right peeks previous', () => {
    expect(peekDirection(-5)).toBe('next');
    expect(peekDirection(5)).toBe('previous');
    expect(peekDirection(0)).toBeNull();
  });
  it('offset is 1:1 with a neighbour, clamped, and rubber-banded without', () => {
    expect(carouselOffset(-120, 400, true, true)).toBe(-120);
    expect(carouselOffset(-900, 400, true, true)).toBe(-400);
    const rb = carouselOffset(-300, 400, true, false);
    expect(rb).toBeLessThan(0);
    expect(Math.abs(rb)).toBeLessThan(120);
    expect(carouselOffset(0, 400, true, true)).toBe(0);
  });
  it('commit decision uses distance, flick and reversal', () => {
    expect(decideCarousel(-120, 0, 400, true, true)).toBe('next');
    expect(decideCarousel(120, 0, 400, true, true)).toBe('previous');
    expect(decideCarousel(-50, 0, 400, true, true)).toBe('cancel');
    expect(decideCarousel(-50, -0.8, 400, true, true)).toBe('next');
    expect(decideCarousel(-150, 0.5, 400, true, true)).toBe('cancel');
    expect(decideCarousel(-300, 0, 400, true, false)).toBe('cancel');
    expect(decideCarousel(300, 0, 400, false, true)).toBe('cancel');
  });
  it('settle target and duration', () => {
    expect(settleTarget('next', 400)).toBe(-400);
    expect(settleTarget('previous', 400)).toBe(400);
    expect(settleTarget('cancel', 400)).toBe(0);
    expect(settleDuration(-100, -400, 0)).toBe(250);
    expect(settleDuration(-100, -400, 3)).toBe(140);
    expect(settleDuration(-390, -400, 0.05)).toBe(200);
    expect(settleDuration(-390, -400, 0.01)).toBe(250);
    expect(settleDuration(-400, -400, 1)).toBe(0);
    expect(settleDuration(0, -300, 0.5)).toBe(320);
    expect(carouselProgress(-200, 400)).toBe(0.5);
  });
});
