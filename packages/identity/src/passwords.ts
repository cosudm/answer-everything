import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// OWASP-aligned scrypt parameters (N=2^15, r=8, p=1), 32-byte key.
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  const key = await scrypt(password.normalize("NFKC"), salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Basic strength policy: length and not in a tiny deny list. Length is the
 * dominant factor; composition rules are deliberately not enforced.
 */
export function passwordPolicyViolation(password: string, email?: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 256) return "Password is too long.";
  const lowered = password.toLowerCase();
  if (email && lowered.includes(email.split("@")[0]!.toLowerCase())) return "Password must not contain your email.";
  if (/^(password|qwertyuiop|123456789012|letmeinletmein)/.test(lowered)) return "Password is too common.";
  return null;
}
