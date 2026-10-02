import { describe, expect, it } from 'vitest';
import { HashRing, type RingNode } from './ring.js';

const nodes = (ids: string[]): RingNode[] => ids.map((id) => ({ id, value: `ws://${id}` }));

describe('HashRing', () => {
  it('returns undefined on an empty ring', () => {
    expect(new HashRing([]).nodeFor('anything')).toBeUndefined();
  });

  it('is deterministic — same key, same node, across constructions', () => {
    const ring1 = new HashRing(nodes(['a', 'b', 'c']));
    const ring2 = new HashRing(nodes(['a', 'b', 'c']));
    for (const key of ['game-1', 'game-2', 'game-3', 'game-4']) {
      expect(ring1.nodeFor(key)?.id).toBe(ring2.nodeFor(key)?.id);
    }
  });

  it('spreads keys roughly evenly across nodes', () => {
    const ring = new HashRing(nodes(['a', 'b', 'c', 'd']));
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) {
      const n = ring.nodeFor(`game-${i}`);
      counts.set(n!.id, (counts.get(n!.id) ?? 0) + 1);
    }
    // With 10k keys over 4 nodes, each should land in 2000-3000 range.
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(1_800);
      expect(c).toBeLessThan(3_200);
    }
  });

  it('removing one node reroutes roughly 1/N of keys', () => {
    const before = new HashRing(nodes(['a', 'b', 'c', 'd']));
    const after = new HashRing(nodes(['a', 'b', 'c']));
    let moved = 0;
    for (let i = 0; i < 10_000; i++) {
      const key = `game-${i}`;
      if (before.nodeFor(key)?.id !== after.nodeFor(key)?.id) moved += 1;
    }
    // Expect ~2500 moved (1/4). Allow wide tolerance.
    expect(moved).toBeGreaterThan(1_800);
    expect(moved).toBeLessThan(3_200);
  });

  it('ids reflects the registered members', () => {
    const ring = new HashRing(nodes(['a', 'b', 'c']));
    expect(ring.ids().sort()).toEqual(['a', 'b', 'c']);
    expect(ring.size()).toBe(3);
  });
});
