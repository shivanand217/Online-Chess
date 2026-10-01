import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDEN, isExpired, windowFor } from './widen.js';

describe('windowFor', () => {
  it('returns the initial window at zero wait', () => {
    expect(windowFor(0)).toBe(DEFAULT_WIDEN.initialWindow);
  });

  it('grows linearly with wait time', () => {
    // 2s × 25 pts/s + 50 initial = 100.
    expect(windowFor(2_000)).toBe(100);
  });

  it('clamps at the configured maximum', () => {
    // Far past the ramp — must saturate at maxWindow.
    expect(windowFor(10 * 60 * 1000)).toBe(DEFAULT_WIDEN.maxWindow);
  });

  it('treats negative wait (clock skew) as zero', () => {
    expect(windowFor(-5_000)).toBe(DEFAULT_WIDEN.initialWindow);
  });

  it('is monotonically non-decreasing', () => {
    let prev = -1;
    for (let ms = 0; ms <= 90_000; ms += 500) {
      const w = windowFor(ms);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });
});

describe('isExpired', () => {
  it('is false before maxWaitMs', () => {
    expect(isExpired(DEFAULT_WIDEN.maxWaitMs - 1)).toBe(false);
  });

  it('is true at and past maxWaitMs', () => {
    expect(isExpired(DEFAULT_WIDEN.maxWaitMs)).toBe(true);
    expect(isExpired(DEFAULT_WIDEN.maxWaitMs + 1)).toBe(true);
  });
});
