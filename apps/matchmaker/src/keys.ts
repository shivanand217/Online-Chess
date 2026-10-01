// One sorted-set pool per time control (score = rating, member = requestId), with per-request metadata
// in a sibling hash. Keeping the key layout here means pool/claim/widen can't drift from each other.

export const poolKey = (timeControl: string): string => `mm:pool:${timeControl}`;

export const requestKey = (requestId: string): string => `mm:req:${requestId}`;

/** Channel the gateway subscribes to for a given request's pairing result. */
export const matchChannel = (requestId: string): string => `match:${requestId}`;
