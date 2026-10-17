import {
  derEcdsaToRaw,
  parseSignedCallback,
  verifyAdMobSignature,
} from './verification.ts';

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function urlBase64(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function encodeDer(raw: Uint8Array): Uint8Array {
  const positive = (part: Uint8Array): number[] => {
    let index = 0;
    while (index < part.length - 1 && part[index] === 0) index++;
    const digits = Array.from(part.slice(index));
    if (digits[0] & 0x80) digits.unshift(0);
    return [2, digits.length, ...digits];
  };
  const components = [...positive(raw.slice(0, 32)), ...positive(raw.slice(32))];
  return Uint8Array.from([0x30, components.length, ...components]);
}

Deno.test('Google SSV key format and DER signature verify with synthetic ECDSA key', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const signed = 'ad_network=5450213213286189855&custom_data=user%3Astock&timestamp=1700000000000&transaction_id=0123456789abcdef';
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(signed),
  ));
  ensure(signature.length === 64, 'Web Crypto ECDSA must use 64-byte raw signature');
  const der = encodeDer(signature);
  const url = 'https://example.invalid/callback?' + signed +
    '&signature=' + urlBase64(der) + '&key_id=42';
  const keys = { keys: [{ keyId: 42, base64: base64(spki) }] };
  ensure(await verifyAdMobSignature(url, keys), 'signed callback should verify');
  ensure(!await verifyAdMobSignature(url.replace('timestamp=1700000000000', 'timestamp=1800000000000'), keys),
    'modified signed fields must fail');
  ensure(!await verifyAdMobSignature(url.replace('key_id=42', 'key_id=43'), keys),
    'untrusted key ID must fail');
  ensure(!await verifyAdMobSignature(url + '&transaction_id=bad', keys),
    'unexpected trailer must fail');
  ensure(!await verifyAdMobSignature(url.replace('&signature=', '&key_id=42&signature='), keys),
    'reordered callback must fail');
  ensure(parseSignedCallback(url).keyId === '42', 'key id parsed without rewriting signed content');
});

Deno.test('SSV DER parser rejects malformed signatures instead of accepting unsigned reward', () => {
  for (const malformed of [
    new Uint8Array(0),
    new Uint8Array([0x30, 0x01, 0x02]),
    new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01]),
    new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0]),
  ]) {
    let rejected = false;
    try {
      derEcdsaToRaw(malformed);
    } catch {
      rejected = true;
    }
    ensure(rejected, 'malformed DER signature must be rejected');
  }
});

Deno.test('SSV callback rejects duplicate signature/key fields', () => {
  const invalid = [
    'https://example.invalid/callback?ad_network=1&signature=first&signature=second&key_id=42',
    'https://example.invalid/callback?ad_network=1&key_id=42&signature=second&key_id=42',
    'https://example.invalid/callback?signature=second&key_id=42',
  ];
  for (const url of invalid) {
    let rejected = false;
    try {
      parseSignedCallback(url);
    } catch {
      rejected = true;
    }
    ensure(rejected, 'duplicate or unsigned callback fields must be rejected');
  }
});
