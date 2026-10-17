/** Pure AdMob SSV verification. Never trust decoded reward fields until signature verifies. */
export type AdMobVerifierKey = { keyId: number | string; base64: string };
export type SignedCallback = { payload: Uint8Array; signature: Uint8Array; keyId: string };

export function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length > 4096) {
    throw new Error('INVALID_BASE64');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function parseSignedCallback(requestUrl: string): SignedCallback {
  const query = new URL(requestUrl).search.slice(1);
  // Google always appends signature and key_id last. Preserve the exact,
  // still-percent-encoded preceding bytes (never reserialize URLSearchParams).
  const match = /^(.+)&signature=([A-Za-z0-9_-]+)&key_id=(\d+)$/.exec(query);
  if (!match || match[1].split('&').some((part) =>
    part.startsWith('signature=') || part.startsWith('key_id=')
  )) {
    throw new Error('INVALID_SSV_CALLBACK_FORMAT');
  }
  return {
    payload: new TextEncoder().encode(match[1]),
    signature: decodeBase64(match[2]),
    keyId: match[3],
  };
}

/** Google ECDSA signatures are DER; Web Crypto ECDSA verification uses raw r||s. */
export function derEcdsaToRaw(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 ||
      der[1] !== der.length - 2) {
    throw new Error('INVALID_ECDSA_DER');
  }
  let cursor = 2;
  const readInteger = (): Uint8Array => {
    if (der[cursor++] !== 0x02) throw new Error('INVALID_ECDSA_DER');
    const length = der[cursor++];
    if (length < 1 || length > 33 || cursor + length > der.length) {
      throw new Error('INVALID_ECDSA_DER');
    }
    const encoded = der.slice(cursor, cursor + length);
    cursor += length;
    // DER INTEGER must be nonnegative and minimally encoded.
    if ((encoded[0] & 0x80) !== 0 ||
        (encoded.length > 1 && encoded[0] === 0 &&
         (encoded[1] & 0x80) === 0)) {
      throw new Error('INVALID_ECDSA_DER');
    }
    const positive = encoded[0] === 0 ? encoded.slice(1) : encoded;
    if (positive.length > 32) throw new Error('INVALID_ECDSA_DER');
    const result = new Uint8Array(32);
    result.set(positive, 32 - positive.length);
    return result;
  };
  const r = readInteger();
  const s = readInteger();
  if (cursor !== der.length) throw new Error('INVALID_ECDSA_DER');
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

export async function verifyAdMobSignature(
  callbackUrl: string,
  verifierKeys: { keys?: AdMobVerifierKey[] },
): Promise<boolean> {
  try {
    const callback = parseSignedCallback(callbackUrl);
    const entry = verifierKeys.keys?.find((key) =>
      String(key.keyId) === callback.keyId
    );
    // Google's key server publishes X.509 SubjectPublicKeyInfo DER in
    // the base64 field, not separate x/y point coordinates.
    if (!entry?.base64) return false;
    const key = await crypto.subtle.importKey(
      'spki',
      decodeBase64(entry.base64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      derEcdsaToRaw(callback.signature),
      callback.payload,
    );
  } catch {
    return false;
  }
}
