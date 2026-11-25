// WebCrypto helpers (available on Workers and Node >= 20 as globalThis.crypto).

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const ALPH = "0123456789abcdefghjkmnpqrstvwxyz";
export function newId(prefix: string): string {
  const r = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of r) s += ALPH[b & 31];
  return `${prefix}_${s}`;
}

export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

const PBKDF2_ITER = 100_000; // Workers caps PBKDF2 at 100k iterations.

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2-sha256$${PBKDF2_ITER}$${b64url(salt)}$${b64url(h)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2-sha256" || !iter || !salt || !hash) return false;
  const h = await pbkdf2(password, fromB64url(salt), Number(iter));
  return timingSafeEqual(b64url(h), hash);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** AES-256-GCM with a 32-byte key given as base64 or base64url. Output: v1.<iv>.<ciphertext>. */
export class SecretBox {
  private keyP: Promise<CryptoKey>;
  constructor(keyB64: string) {
    const raw = fromB64url(keyB64.trim());
    if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
    this.keyP = crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async seal(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.keyP, enc.encode(plain));
    return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
  }
  async open(sealed: string): Promise<string> {
    const [v, iv, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !ct) throw new Error("bad sealed value");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) as BufferSource }, await this.keyP, fromB64url(ct) as BufferSource);
    return dec.decode(pt);
  }
}
