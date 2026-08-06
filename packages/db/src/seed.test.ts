import { describe, it, expect } from 'vitest';
import { makePlayers } from './seed.js';

describe('makePlayers', () => {
  it('generates the requested count with unique, zero-padded usernames', () => {
    const rows = makePlayers(500);
    expect(rows).toHaveLength(500);
    expect(new Set(rows.map((r) => r.username)).size).toBe(500);
    expect(rows[0]?.username).toBe('player_000000');
    expect(rows[499]?.username).toBe('player_000499');
  });

  it('clamps every rating into [400, 2800]', () => {
    for (const r of makePlayers(5000)) {
      expect(r.rating).toBeGreaterThanOrEqual(400);
      expect(r.rating).toBeLessThanOrEqual(2800);
    }
  });

  it('produces a roughly centred distribution (mean near 1500)', () => {
    const rows = makePlayers(20_000);
    const mean = rows.reduce((sum, r) => sum + r.rating, 0) / rows.length;
    expect(mean).toBeGreaterThan(1400);
    expect(mean).toBeLessThan(1600);
  });

  it('continues numbering from startIndex', () => {
    expect(makePlayers(3, 1000)[0]?.username).toBe('player_001000');
  });
});
