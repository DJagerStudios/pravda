// Pravda's cryptography, built only on WebCrypto primitives (no custom
// ciphers): P-256 ECDH and ECDSA, AES-256-GCM, HKDF-SHA-256, PBKDF2-SHA-256.
// See docs/PROTOCOL.md for how the pieces fit together.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITERATIONS = 600_000;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export function toB64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

export const toB64url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * Stretches a password into two independent secrets: the auth key, which is
 * all the server ever receives, and the wrap key, which never leaves this
 * device and seals the user's private keys.
 */
export async function stretchPassword(password, saltB64, iterations) {
  const base = await subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations }, base, 512));
  const authKey = toB64(bits.slice(0, 32));
  const wrapKey = await subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  bits.fill(0);
  return { authKey, wrapKey };
}

async function seal(key, plain, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, plain);
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function unseal(key, { iv, ct }, aad) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: te.encode(aad) }, key, fromB64(ct)));
}

/** A new identity: a signing key pair and a key-agreement key pair. */
export async function generateIdentity() {
  const sign = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const dh = await subtle.generateKey(ECDH, true, ['deriveBits']);
  return {
    signPriv: sign.privateKey,
    dhPriv: dh.privateKey,
    signPub: toB64(await subtle.exportKey('spki', sign.publicKey)),
    dhPub: toB64(await subtle.exportKey('spki', dh.publicKey)),
  };
}

const BUNDLE_AAD = 'pravda/bundle/v1';

/** Seals the private keys with a wrap key (from the password or recovery key). */
export async function sealBundle(identity, wrapKey) {
  const body = te.encode(JSON.stringify({
    sign: toB64(await subtle.exportKey('pkcs8', identity.signPriv)),
    dh: toB64(await subtle.exportKey('pkcs8', identity.dhPriv)),
  }));
  const sealed = await seal(wrapKey, body, BUNDLE_AAD);
  body.fill(0);
  return JSON.stringify({ v: 1, ...sealed });
}

/**
 * Opens a bundle. The private keys come back non-extractable: they can sign
 * and agree keys, but even this page's own code can no longer read them out.
 * The extractable copies are returned separately for re-sealing only.
 */
export async function openBundle(bundle, wrapKey, { extractable = false } = {}) {
  const parsed = JSON.parse(bundle);
  const body = JSON.parse(td.decode(await unseal(wrapKey, parsed, BUNDLE_AAD)));
  return {
    signPriv: await subtle.importKey('pkcs8', fromB64(body.sign), ECDSA, extractable, ['sign']),
    dhPriv: await subtle.importKey('pkcs8', fromB64(body.dh), ECDH, extractable, ['deriveBits']),
  };
}

const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A recovery key: 256 random bits shown as grouped Crockford base32. */
export function newRecoveryKey() {
  const raw = randomBytes(32);
  return { raw, text: formatRecoveryKey(raw) };
}

export function formatRecoveryKey(raw) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += RECOVERY_ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

export function parseRecoveryKey(text) {
  const clean = text.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const n = RECOVERY_ALPHABET.indexOf(ch);
    if (n < 0) throw new Error('That recovery key has characters that do not belong in one.');
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (out.length < 32) throw new Error('That recovery key is too short.');
  return new Uint8Array(out.slice(0, 32));
}

/**
 * Two independent secrets from a recovery key: one seals a second copy of the
 * private keys, the other proves to the server that the holder may reset the
 * password. The server only ever sees the second.
 */
export async function recoverySecrets(raw) {
  const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const salt = te.encode('pravda/recovery/v1');
  const wrapKey = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('wrap') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const auth = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('auth') }, base, 256);
  return { wrapKey, authKey: toB64(auth) };
}

const publicKeys = new Map();

function importPublic(b64, algorithm, usages) {
  const cacheKey = `${algorithm.name}:${b64}`;
  let key = publicKeys.get(cacheKey);
  if (!key) {
    key = subtle.importKey('spki', fromB64(b64), algorithm, true, usages);
    publicKeys.set(cacheKey, key);
  }
  return key;
}

/**
 * A user's fingerprint: 30 digits derived from both public keys. Two people
 * comparing fingerprints out loud can be sure nobody substituted keys.
 */
export async function fingerprint(signB64, dhB64) {
  const data = new Uint8Array([...fromB64(signB64), ...fromB64(dhB64)]);
  const hash = new Uint8Array(await subtle.digest('SHA-512', data));
  const groups = [];
  for (let i = 0; i < 6; i += 1) {
    let n = 0;
    for (let j = 0; j < 5; j += 1) n = n * 256 + hash[i * 5 + j];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

/** The number two people compare: both fingerprints, in a fixed order. */
export function safetyNumber(fpA, fpB) {
  return [fpA, fpB].sort().join(' ');
}

async function pairKey(dhPriv, peerDhB64, scope, epoch, from, to) {
  const peer = await importPublic(peerDhB64, ECDH, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, dhPriv, 256);
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(`pravda/wrap/v1|${scope}|${epoch}`), info: te.encode(`${from}>${to}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Seals a symmetric key for one recipient. Only sender and recipient can open it. */
export async function sealKeyFor({ dhPriv, recipientDh, raw, scope, epoch, from, to }) {
  const key = await pairKey(dhPriv, recipientDh, scope, epoch, from, to);
  return JSON.stringify({ v: 1, ...(await seal(key, raw, `pravda/key/v1|${scope}|${epoch}|${from}|${to}`)) });
}

export async function openSealedKey({ dhPriv, senderDh, wrapped, scope, epoch, from, to }) {
  const key = await pairKey(dhPriv, senderDh, scope, epoch, from, to);
  const raw = await unseal(key, JSON.parse(wrapped), `pravda/key/v1|${scope}|${epoch}|${from}|${to}`);
  if (raw.length !== 32) throw new Error('A sealed key had the wrong length.');
  return raw;
}

export const importContentKey = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

/**
 * Encrypts and signs an object. The signature binds the ciphertext to its
 * author, so even someone holding the channel key cannot forge another
 * member's message.
 */
export async function encryptEnvelope({ key, epoch, body, aad, signPriv }) {
  const sealed = await seal(key, te.encode(JSON.stringify(body)), aad);
  const envelope = { v: 1, ...sealed };
  if (epoch !== undefined) envelope.e = epoch;
  if (signPriv) {
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signPriv, te.encode(`${aad}|${sealed.iv}|${sealed.ct}`));
    envelope.sig = toB64(sig);
  }
  return JSON.stringify(envelope);
}

export class DecryptError extends Error {}

/** Verifies (when a signing key is given) and decrypts an envelope. */
export async function decryptEnvelope({ envelope, key, aad, signPub }) {
  const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (signPub) {
    if (!parsed.sig) throw new DecryptError('unsigned');
    const pub = await importPublic(signPub, ECDSA, ['verify']);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64(parsed.sig), te.encode(`${aad}|${parsed.iv}|${parsed.ct}`));
    if (!ok) throw new DecryptError('bad signature');
  }
  try {
    return JSON.parse(td.decode(await unseal(key, parsed, aad)));
  } catch {
    throw new DecryptError('cannot decrypt');
  }
}

export function envelopeEpoch(envelope) {
  try {
    return JSON.parse(envelope).e ?? 0;
  } catch {
    return -1;
  }
}

/** Encrypts a file with its own random key. */
export async function encryptFile(buffer) {
  const raw = randomBytes(32);
  const iv = randomBytes(12);
  const key = await importContentKey(raw);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer));
  return { data, key: toB64(raw), iv: toB64(iv) };
}

export async function decryptFile(buffer, keyB64, ivB64) {
  const key = await importContentKey(fromB64(keyB64));
  return subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, key, buffer);
}

/** The per-call media key, derived from the channel key of a generation. */
export async function deriveMediaKey(raw, channelId, epoch) {
  const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode('pravda/media/v1'), info: te.encode(`${channelId}|${epoch}`) },
    base,
    256,
  ));
}
