// Thin wrapper around the matchmaker's HTTP surface. Keeping the fetch calls behind a typed client
// means the long-poll route doesn't deal with URLs or JSON shapes directly.
import type { EnqueueRequest, EnqueueResponse } from '@chess/protocol';

export interface MatchmakerClient {
  enqueue: (req: EnqueueRequest) => Promise<EnqueueResponse>;
  cancel: (requestId: string) => Promise<void>;
}

export function createMatchmakerClient(baseUrl: string): MatchmakerClient {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async enqueue(req) {
      const res = await fetch(`${root}/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        throw new Error(`matchmaker enqueue failed: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as EnqueueResponse;
    },
    async cancel(requestId) {
      // Best-effort — a 404 from a race with the sweeper is still a successful cancel from our view.
      await fetch(`${root}/enqueue/${encodeURIComponent(requestId)}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    },
  };
}
