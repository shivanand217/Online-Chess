// Consistent-hash ring. Each node contributes `virtualNodes` evenly-spaced slots on the ring so a single
// node leaving redistributes only ~1/N of keys. The hash is FNV-1a (32-bit) — pure JS, dependency-free,
// and good enough for routing; we don't need cryptographic strength.

export interface RingNode {
  id: string;
  value: string;
}

export class HashRing {
  private readonly slots: Array<{ hash: number; nodeId: string }> = [];
  private readonly byId = new Map<string, string>();

  constructor(
    nodes: RingNode[],
    private readonly virtualNodes = 128,
  ) {
    for (const node of nodes) this.add(node);
    this.slots.sort((a, b) => a.hash - b.hash);
  }

  private add(node: RingNode): void {
    this.byId.set(node.id, node.value);
    for (let i = 0; i < this.virtualNodes; i++) {
      this.slots.push({ hash: fnv1a(`${node.id}#${i}`), nodeId: node.id });
    }
  }

  /** The node that owns `key`, or undefined if the ring is empty. */
  nodeFor(key: string): RingNode | undefined {
    if (this.slots.length === 0) return undefined;
    const h = fnv1a(key);
    // First slot with hash >= h; wrap to 0 if none.
    let lo = 0;
    let hi = this.slots.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const slot = this.slots[mid];
      if (slot && slot.hash < h) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo === this.slots.length ? 0 : lo;
    const slot = this.slots[idx];
    if (!slot) return undefined;
    const value = this.byId.get(slot.nodeId);
    return value === undefined ? undefined : { id: slot.nodeId, value };
  }

  size(): number {
    return this.byId.size;
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }
}

/** FNV-1a 32-bit hash. Returns an unsigned 32-bit integer. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
