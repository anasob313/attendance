// Reads and cleans the function's secrets. Values pasted on a phone often
// arrive with spaces, quotes, a "NAME=" prefix, or auto-replaced dashes;
// these are repaired here so the keys themselves never need regenerating.
import { createECDH } from 'node:crypto';

/** Repair common copy/paste damage in a secret value. */
export function cleanSecret(raw: string | undefined, name: string): string {
  let v = (raw ?? '').normalize('NFKC').trim();
  v = v.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
  const prefix = new RegExp(`^${name}\\s*[:=]\\s*`, 'i');
  v = v.replace(prefix, '');
  return v.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
}

/** Base64url keys: also undo iOS "smart punctuation" and base64 variants. */
export function cleanKey(raw: string | undefined, name: string): string {
  return cleanSecret(raw, name)
    .replace(/—/g, '--')          // em dash   ← iOS turns "--" into "—"
    .replace(/[–−‐‑]/g, '-')
    .replace(/\s+/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function cleanSubject(raw: string | undefined): string {
  const v = cleanSecret(raw, 'VAPID_SUBJECT').replace(/\s+/g, '');
  if (!v) return '';
  if (/^(mailto:|https:\/\/)/i.test(v)) return v;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return `mailto:${v}`;
  return v;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  cronSecret: string;
  /** Human-readable problems; never contains private values. */
  problems: string[];
}

export function readConfig(env: (k: string) => string | undefined): VapidConfig {
  const publicKey = cleanKey(env('VAPID_PUBLIC_KEY'), 'VAPID_PUBLIC_KEY');
  const privateKey = cleanKey(env('VAPID_PRIVATE_KEY'), 'VAPID_PRIVATE_KEY');
  const subject = cleanSubject(env('VAPID_SUBJECT'));
  const cronSecret = cleanSecret(env('CRON_SECRET'), 'CRON_SECRET');
  const problems: string[] = [];

  let pubBytes: Uint8Array | null = null;
  if (!publicKey) problems.push('VAPID_PUBLIC_KEY is empty');
  else if (!B64URL.test(publicKey)) problems.push(`VAPID_PUBLIC_KEY has invalid characters (length ${publicKey.length})`);
  else {
    pubBytes = b64urlDecode(publicKey);
    if (pubBytes.length !== 65) problems.push(`VAPID_PUBLIC_KEY decodes to ${pubBytes.length} bytes, expected 65 (length ${publicKey.length}, expected 87)`);
  }

  let privBytes: Uint8Array | null = null;
  if (!privateKey) problems.push('VAPID_PRIVATE_KEY is empty');
  else if (!B64URL.test(privateKey)) problems.push('VAPID_PRIVATE_KEY has invalid characters');
  else {
    privBytes = b64urlDecode(privateKey);
    if (privBytes.length !== 32) problems.push(`VAPID_PRIVATE_KEY decodes to ${privBytes.length} bytes, expected 32`);
  }

  if (pubBytes?.length === 65 && privBytes?.length === 32) {
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(privBytes);
      const derived = new Uint8Array(ecdh.getPublicKey());
      if (derived.length !== 65 || derived.some((b, i) => b !== pubBytes![i])) {
        problems.push('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a matching pair');
      }
    } catch {
      problems.push('VAPID_PRIVATE_KEY is not a valid P-256 key');
    }
  }

  if (!subject) problems.push('VAPID_SUBJECT is empty');
  else if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/i.test(subject)) problems.push('VAPID_SUBJECT must be "mailto:you@example.com" or an https:// URL');

  if (cronSecret.length < 16) problems.push('CRON_SECRET is missing or too short');

  return { publicKey, privateKey, subject, cronSecret, problems };
}
