import { getPushSubscriptionsForLineAccount, pruneInvalidPushSubscription } from '@line-crm/db';

// Web Push sender for Cloudflare Workers.
//
// Implements VAPID (RFC 8292, draft "Authorization: vapid" scheme) and
// Web Push message encryption (RFC 8291, aes128gcm) from scratch using the
// platform Web Crypto API — the npm `web-push` package assumes a Node runtime
// and cannot run in Workers, and no third-party Workers-compatible push
// library is used here to avoid an unvetted crypto dependency. See
// web-push.test.ts, which checks this implementation's encryption output
// against the official RFC 8291 Appendix A worked example byte-for-byte.

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed EC point
  auth: string; // base64url, 16 bytes
}

export interface VapidKeys {
  publicKeyB64Url: string; // base64url, 65-byte uncompressed EC point
  privateKeyB64Url: string; // base64url, PKCS8 DER
  subject: string; // VAPID JWT "sub" claim, e.g. "mailto:admin@example.com"
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  url: string;
  tag?: string;
}

export interface SendWebPushResult {
  ok: boolean;
  status: number;
  /** true when the push service reports the subscription is gone (404/410) and it should be pruned. */
  expired: boolean;
}

// --- base64url helpers (Workers has global atob/btoa, but they are ASCII-only) ---

function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(input: string): string {
  return base64UrlEncode(new TextEncoder().encode(input));
}

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// @cloudflare/workers-types types generateKey/deriveBits loosely (CryptoKey |
// CryptoKeyPair unions, and EcdhKeyDeriveParams' `public` field is mistyped as
// `$public`) even though the Workers runtime implements the real Web Crypto
// spec shapes. These narrow casts bridge that gap without `any` leaking out.
async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
}

async function deriveEcdhSharedBits(privateKey: CryptoKey, publicKey: CryptoKey, lengthBits: number): Promise<ArrayBuffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algorithm = { name: 'ECDH', public: publicKey } as any;
  return crypto.subtle.deriveBits(algorithm, privateKey, lengthBits);
}

async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// --- VAPID JWT (ES256) ---

async function importVapidPrivateKey(privateKeyB64Url: string): Promise<CryptoKey> {
  const pkcs8 = base64UrlDecode(privateKeyB64Url);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function buildVapidJwt(endpoint: string, keys: VapidKeys): Promise<string> {
  const origin = new URL(endpoint).origin; // VAPID "aud" must be the push service's origin
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: origin, exp: now + 12 * 60 * 60, sub: keys.subject };
  const unsigned = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(payload))}`;
  const privateKey = await importVapidPrivateKey(keys.privateKeyB64Url);
  // Web Crypto's ECDSA sign() returns the raw (r || s) fixed-length IEEE P1363
  // signature, which is exactly what a JWS ES256 signature needs — no DER
  // conversion required (unlike, say, OpenSSL's default ECDSA output).
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

// --- RFC 8291 aes128gcm payload encryption ---

async function importEcdhPublicKeyRaw(rawB64Url: string): Promise<CryptoKey> {
  const raw = base64UrlDecode(rawB64Url);
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, lengthBytes: number): Promise<Uint8Array> {
  // crypto.subtle's HKDF algorithm performs the full extract-then-expand in
  // one call (salt is the extract salt, info is the expand context).
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

const WEB_PUSH_INFO_PREFIX = new TextEncoder().encode('WebPush: info\0');
const CEK_INFO = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
const NONCE_INFO = new TextEncoder().encode('Content-Encoding: nonce\0');
const RECORD_SIZE = 4096;

export interface EncryptOptions {
  /** Override the random 16-byte record salt (tests only). */
  salt?: Uint8Array;
  /** Override the ephemeral application-server ECDH key pair (tests only). */
  ephemeralKeyPair?: CryptoKeyPair;
}

/** Encrypts `plaintext` per RFC 8291 for the given subscription. Returns the full aes128gcm body to POST. */
export async function encryptPayload(
  sub: PushSubscriptionKeys,
  plaintext: string,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublicKey = await importEcdhPublicKeyRaw(sub.p256dh);
  const uaPublicRaw = base64UrlDecode(sub.p256dh);
  const authSecret = base64UrlDecode(sub.auth);

  const ephemeralKeyPair = opts.ephemeralKeyPair ?? (await generateEcdhKeyPair());
  const asPublicRaw = await exportKeyRaw(ephemeralKeyPair.publicKey);

  const sharedSecretBits = await deriveEcdhSharedBits(ephemeralKeyPair.privateKey, uaPublicKey, 256);
  const sharedSecret = new Uint8Array(sharedSecretBits);

  const keyInfo = concatBytes(WEB_PUSH_INFO_PREFIX, uaPublicRaw, asPublicRaw);
  // Combined HKDF-Extract(salt=auth_secret, ikm=ecdh_secret) + Expand(info=keyInfo) per RFC 8291 §3.4.
  const ikm = await hkdf(sharedSecret, authSecret, keyInfo, 32);

  const recordSalt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, recordSalt, CEK_INFO, 16);
  const nonce = await hkdf(ikm, recordSalt, NONCE_INFO, 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // Single (last) record: plaintext + 0x02 delimiter, no extra padding.
  const padded = concatBytes(new TextEncoder().encode(plaintext), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, padded),
  );

  const recordSizeBytes = new Uint8Array(4);
  new DataView(recordSizeBytes.buffer).setUint32(0, RECORD_SIZE, false);
  const header = concatBytes(recordSalt, recordSizeBytes, new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concatBytes(header, ciphertext);
}

/** Sends one Web Push message. Caller is responsible for pruning the subscription when `expired` is true. */
export async function sendWebPush(
  sub: PushSubscriptionKeys,
  payload: PushPayload,
  keys: VapidKeys,
): Promise<SendWebPushResult> {
  const jwt = await buildVapidJwt(sub.endpoint, keys);
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Authorization: `vapid t=${jwt}, k=${keys.publicKeyB64Url}`,
    },
    body: body as BodyInit,
  });
  const expired = res.status === 404 || res.status === 410;
  return { ok: res.ok, status: res.status, expired };
}

export interface NotifiableEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/** Fans a push out to every staff subscription registered for the given LINE account. No-ops silently if VAPID is unconfigured. */
export async function notifyStaffOfIncomingMessage(
  db: D1Database,
  env: NotifiableEnv,
  lineAccountId: string | null,
  payload: PushPayload,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  const keys: VapidKeys = {
    publicKeyB64Url: env.VAPID_PUBLIC_KEY,
    privateKeyB64Url: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
  };

  const subs = await getPushSubscriptionsForLineAccount(db, lineAccountId);
  for (const sub of subs) {
    const task = sendWebPush(sub, payload, keys)
      .then((result) => {
        if (result.expired) return pruneInvalidPushSubscription(db, sub.endpoint);
      })
      .catch((err) => console.error('[web-push] send failed', sub.endpoint, err));
    waitUntil(task);
  }
}
