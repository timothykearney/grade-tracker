// Passphrase encryption for the published data: PBKDF2-SHA256 -> AES-256-GCM.
// Uses only Web Crypto, so the same code runs in the browser and in Node (build step).

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(value, passphrase, iterations = 600_000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

/** Throws if the passphrase is wrong (AES-GCM authentication fails). */
export async function unseal(box, passphrase) {
  const key = await deriveKey(passphrase, fromB64(box.salt), box.iterations);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}
