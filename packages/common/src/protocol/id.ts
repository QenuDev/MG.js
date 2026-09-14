/**
 * Identifier generation that works identically in every runtime this package targets:
 * a browser page, a userscript sandbox, and Node.
 *
 * `crypto.randomUUID()` is available in Node 19+ and in browsers on secure origins, but a userscript
 * sandbox can be granted a `window` without `crypto`, and a plain-HTTP origin has no
 * `crypto.randomUUID` at all. So the fallback is not theoretical.
 */

/**
 * A v4-shaped UUID string.
 *
 * Preference order: `crypto.randomUUID` → `crypto.getRandomValues` → `Math.random`. The last is
 * weaker but these ids are protocol-level correlation tokens, not security material; the important
 * property is uniqueness within a session, not unpredictability.
 */
export function randomUuid(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;

  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Set version (4) and variant (10xx) bits, per RFC 4122 §4.4.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) hex.push((bytes[i] as number).toString(16).padStart(2, '0'));

  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-` +
    `${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

/**
 * A random lowercase-alphanumeric room slug.
 *
 * The protocol doc says to "omit it (or generate a fresh random one) to get a private room of your
 * own". This is the shape a private-room slug takes.
 */
export function randomRoomSlug(length = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  const out: string[] = [];

  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(length);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < length; i += 1) {
      out.push(alphabet[(bytes[i] as number) % alphabet.length] as string);
    }
  } else {
    for (let i = 0; i < length; i += 1) {
      out.push(alphabet[Math.floor(Math.random() * alphabet.length)] as string);
    }
  }

  return out.join('');
}
