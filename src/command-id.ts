type RandomSource = {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
};

/** getRandomValues is available on ordinary HTTP LAN previews too. Never use Math.random for an action identity. */
export function makeCommandId(random: RandomSource | undefined = globalThis.crypto): string {
  if (typeof random?.randomUUID === 'function') return random.randomUUID();
  if (typeof random?.getRandomValues === 'function') {
    const bytes = random.getRandomValues(new Uint8Array(16));
    return 'cmd_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('This browser cannot create a secure move ID. Open the table in a current browser or over HTTPS.');
}
