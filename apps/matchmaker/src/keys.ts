// Redis key layout for the matchmaker, in one place so pool/claim/widen agree on exactly where things
// live. One sorted-set pool per time control (score = rating, member = requestId) + a per-request hash
// holding the metadata the pairing step needs (playerId, rating, enqueuedAt). Hand-written.

/** Sorted set key for a time control's waiting pool. */
export const poolKey = (timeControl: string): string => `mm:pool:${timeControl}`;

/** Hash key for a single waiter's metadata, keyed by request id. */
export const requestKey = (requestId: string): string => `mm:req:${requestId}`;

/** Pub/sub channel the gateway subscribes to for a given request's match result. */
export const matchChannel = (requestId: string): string => `match:${requestId}`;
