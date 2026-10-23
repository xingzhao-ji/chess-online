type ClaimStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type RandomSource = { getRandomValues?: (bytes: Uint8Array) => Uint8Array };
const key = (roomId: string) => `open-table:pending-black:${roomId}`;
const valid = (value: string) => /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);

export function readPendingClaim(storage: ClaimStorage, roomId: string): string | null {
  const existing = storage.getItem(key(roomId));
  if (existing !== null && !valid(existing)) throw new Error('The saved seat request is damaged. Keep any existing private seat link; this request cannot be recovered automatically.');
  return existing;
}

/** Persist and verify before any request can consume the invitation. Session storage survives a reload in this tab. */
export function prepareSeatClaim(storage: ClaimStorage, roomId: string, random: RandomSource | undefined = globalThis.crypto): string {
  let existing: string | null;
  try { existing = readPendingClaim(storage, roomId); }
  catch { throw new Error('Your saved seat request cannot be read. Enable browser storage before joining; no invitation has been claimed by this attempt.'); }
  if (existing) return existing;
  if (typeof random?.getRandomValues !== 'function') throw new Error('This browser cannot create a secure seat. Use a current browser or HTTPS.');
  const bytes = random.getRandomValues(new Uint8Array(32));
  const token = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try {
    storage.setItem(key(roomId), token);
    if (storage.getItem(key(roomId)) !== token) throw new Error('Storage did not retain the seat.');
  } catch { throw new Error('The seat request could not be saved. Enable browser storage before joining; your invitation has not been claimed by this attempt.'); }
  return token;
}

export function completeSeatClaim(storage: ClaimStorage, roomId: string): void {
  // The private URL has already been installed before cleanup; a cleanup failure must not hide it.
  try { storage.removeItem(key(roomId)); } catch { /* A retained capability is harmless to retry semantics. */ }
}
