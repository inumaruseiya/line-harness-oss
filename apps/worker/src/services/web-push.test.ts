import { describe, it, expect } from 'vitest';
import { encryptPayload, buildVapidJwt, type VapidKeys } from './web-push.js';

// RFC 8291 Appendix A "A Working Example" — https://www.rfc-editor.org/rfc/rfc8291.html
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expectedBody:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function b64urlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importFixedEcdhKeyPair(privateB64url: string, publicB64url: string): Promise<CryptoKeyPair> {
  const pub = b64urlDecode(publicB64url);
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const jwkPrivate: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: b64urlEncode(b64urlDecode(privateB64url)),
    x: b64urlEncode(x),
    y: b64urlEncode(y),
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwkPrivate,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const jwkPublic: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y), ext: true };
  const publicKey = await crypto.subtle.importKey('jwk', jwkPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { privateKey, publicKey } as CryptoKeyPair;
}

describe('encryptPayload (RFC 8291 aes128gcm)', () => {
  it('matches the RFC 8291 Appendix A worked example byte-for-byte', async () => {
    const ephemeralKeyPair = await importFixedEcdhKeyPair(RFC8291.asPrivate, RFC8291.asPublic);
    const salt = b64urlDecode(RFC8291.salt);

    const body = await encryptPayload(
      { endpoint: 'https://push.example.net/push/abc', p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
      RFC8291.plaintext,
      { salt, ephemeralKeyPair },
    );

    expect(b64urlEncode(body)).toBe(RFC8291.expectedBody);
  });
});

describe('buildVapidJwt', () => {
  it('produces a valid ES256 JWS verifiable against the matching public key', async () => {
    const keyPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const publicKeyRaw = new Uint8Array((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer);
    const privateKeyPkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)) as ArrayBuffer);

    const keys: VapidKeys = {
      publicKeyB64Url: b64urlEncode(publicKeyRaw),
      privateKeyB64Url: b64urlEncode(privateKeyPkcs8),
      subject: 'mailto:test@example.com',
    };

    const jwt = await buildVapidJwt('https://fcm.googleapis.com/fcm/send/xyz', keys);
    const [headerB64, payloadB64, sigB64] = jwt.split('.');

    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)));
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(payload.sub).toBe('mailto:test@example.com');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      b64urlDecode(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    expect(verified).toBe(true);
  });
});
