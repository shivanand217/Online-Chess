import { describe, expect, it } from 'vitest';
import { RttTracker, creditFromMedian } from './rtt-tracker.js';

describe('RttTracker', () => {
  it('returns undefined with no samples', () => {
    expect(new RttTracker().median('p1')).toBeUndefined();
  });

  it('returns the single sample as the median', () => {
    const t = new RttTracker();
    t.sample('p1', 42);
    expect(t.median('p1')).toBe(42);
  });

  it('computes the median across an odd-length window', () => {
    const t = new RttTracker();
    for (const ms of [10, 20, 30, 40, 50]) t.sample('p1', ms);
    expect(t.median('p1')).toBe(30);
  });

  it('rounds the midpoint on an even-length window', () => {
    const t = new RttTracker();
    for (const ms of [10, 20, 30, 40]) t.sample('p1', ms);
    expect(t.median('p1')).toBe(25);
  });

  it('ignores a spike thanks to median semantics', () => {
    const t = new RttTracker();
    for (const ms of [40, 50, 42, 48, 45, 2000]) t.sample('p1', ms);
    // Mean would be ~370; median shrugs it off.
    expect(t.median('p1')).toBeLessThan(100);
  });

  it('drops old samples once the window overflows', () => {
    const t = new RttTracker(5);
    for (const ms of [1000, 1000, 1000, 1000, 1000, 10, 10, 10, 10, 10]) t.sample('p1', ms);
    expect(t.median('p1')).toBe(10);
  });

  it('tracks players independently', () => {
    const t = new RttTracker();
    t.sample('a', 100);
    t.sample('b', 20);
    expect(t.median('a')).toBe(100);
    expect(t.median('b')).toBe(20);
  });

  it('rejects negative and non-finite samples', () => {
    const t = new RttTracker();
    t.sample('p1', -5);
    t.sample('p1', Number.NaN);
    t.sample('p1', Number.POSITIVE_INFINITY);
    t.sample('p1', 50);
    expect(t.median('p1')).toBe(50);
  });

  it('clear wipes a player', () => {
    const t = new RttTracker();
    t.sample('p1', 50);
    t.clear('p1');
    expect(t.median('p1')).toBeUndefined();
  });
});

describe('creditFromMedian', () => {
  it('returns 0 when no median is known', () => {
    expect(creditFromMedian(undefined, 100)).toBe(0);
  });

  it('returns half the median under the cap', () => {
    expect(creditFromMedian(60, 100)).toBe(30);
  });

  it('caps the credit so a long-latency client cannot stall the clock', () => {
    expect(creditFromMedian(500, 100)).toBe(100);
  });

  it('floors fractional halves', () => {
    expect(creditFromMedian(45, 100)).toBe(22);
  });
});
