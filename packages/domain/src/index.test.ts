import { describe, it, expect } from 'vitest';
import {
  INITIAL_RATING,
  classifyTimeControl,
  eloDelta,
  expectedScore,
  opponent,
  parseTimeControl,
  ratingChange,
  scoreForWhite,
} from './index.js';

describe('opponent', () => {
  it('flips colour', () => {
    expect(opponent('w')).toBe('b');
    expect(opponent('b')).toBe('w');
  });
});

describe('expectedScore', () => {
  it('is 0.5 for equal ratings', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 10);
  });

  it('is symmetric — the two expected scores sum to 1', () => {
    expect(expectedScore(1500, 1900) + expectedScore(1900, 1500)).toBeCloseTo(1, 10);
  });

  it('favours the higher-rated player', () => {
    expect(expectedScore(1900, 1500)).toBeGreaterThan(0.5);
    expect(expectedScore(1500, 1900)).toBeLessThan(0.5);
  });
});

describe('eloDelta — known deltas', () => {
  it('equal ratings: win +16, loss -16, draw 0 (K=32)', () => {
    expect(eloDelta(1500, 1500, 1)).toBe(16);
    expect(eloDelta(1500, 1500, 0)).toBe(-16);
    expect(eloDelta(1500, 1500, 0.5)).toBe(0);
  });

  it('underdog beating a favourite gains more (+29)', () => {
    expect(eloDelta(1500, 1900, 1)).toBe(29);
  });

  it('favourite beating an underdog gains little (+3)', () => {
    expect(eloDelta(1900, 1500, 1)).toBe(3);
  });

  it('honours a custom K factor', () => {
    expect(eloDelta(1500, 1500, 1, 20)).toBe(10);
  });
});

describe('scoreForWhite', () => {
  it('maps a PGN result to White’s score', () => {
    expect(scoreForWhite('1-0')).toBe(1);
    expect(scoreForWhite('0-1')).toBe(0);
    expect(scoreForWhite('1/2-1/2')).toBe(0.5);
  });
});

describe('ratingChange — both deltas for a finished game', () => {
  it('equal ratings, White wins: +16 / -16', () => {
    expect(ratingChange(1500, 1500, '1-0')).toEqual({ whiteDelta: 16, blackDelta: -16 });
  });

  it('equal ratings, Black wins: -16 / +16', () => {
    expect(ratingChange(1500, 1500, '0-1')).toEqual({ whiteDelta: -16, blackDelta: 16 });
  });

  it('equal ratings, draw: 0 / 0', () => {
    expect(ratingChange(1500, 1500, '1/2-1/2')).toEqual({ whiteDelta: 0, blackDelta: 0 });
  });

  it('underdog White upsets a higher-rated Black: +29 / -29', () => {
    expect(ratingChange(1500, 1900, '1-0')).toEqual({ whiteDelta: 29, blackDelta: -29 });
  });
});

describe('INITIAL_RATING', () => {
  it('matches the players.rating column default', () => {
    expect(INITIAL_RATING).toBe(1500);
  });
});

describe('classifyTimeControl', () => {
  it('classifies by estimated duration (base + 40 × increment)', () => {
    expect(classifyTimeControl(120, 0)).toBe('bullet'); // 2m
    expect(classifyTimeControl(300, 0)).toBe('blitz'); // 5m
    expect(classifyTimeControl(600, 0)).toBe('rapid'); // 10m
    expect(classifyTimeControl(1800, 0)).toBe('classical'); // 30m
  });

  it('folds the increment into the estimate', () => {
    // 2m base + 2s×40 = 200s → blitz, not bullet.
    expect(classifyTimeControl(120, 2)).toBe('blitz');
  });
});

describe('parseTimeControl', () => {
  it('parses base minutes and increment seconds into ms', () => {
    expect(parseTimeControl('blitz-3-2')).toEqual({
      raw: 'blitz-3-2',
      label: 'blitz',
      category: 'blitz',
      initialMs: 180_000,
      incrementMs: 2_000,
    });
  });

  it('handles a zero increment', () => {
    const tc = parseTimeControl('bullet-1-0');
    expect(tc.initialMs).toBe(60_000);
    expect(tc.incrementMs).toBe(0);
    expect(tc.category).toBe('bullet');
  });

  it('derives category from durations, exposing a mislabelled control', () => {
    // Labelled 'bullet' but 10m of play is really rapid.
    const tc = parseTimeControl('bullet-10-0');
    expect(tc.label).toBe('bullet');
    expect(tc.category).toBe('rapid');
  });

  it('throws on a malformed identifier', () => {
    expect(() => parseTimeControl('garbage')).toThrow();
    expect(() => parseTimeControl('blitz-3')).toThrow();
    expect(() => parseTimeControl('3-2')).toThrow();
    expect(() => parseTimeControl('blitz-3-2-1')).toThrow();
  });

  it('throws on a degenerate 0+0 control', () => {
    expect(() => parseTimeControl('bullet-0-0')).toThrow(/degenerate/);
  });
});
