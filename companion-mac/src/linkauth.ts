import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Mutual challenge-response for the WiFi link and OTA (PROTOCOL.md "v4").
 * The token never crosses the network: both sides prove they know it with HMAC-SHA256 over a fresh nonce.
 */
export const NONCE_RE = /^[0-9a-f]{32}$/;

export const hmacHex = (token: string, message: string): string =>
  createHmac('sha256', Buffer.from(token, 'utf8')).update(message, 'ascii').digest('hex');

export const newNonce = (): string => randomBytes(16).toString('hex');

/** What the client sends after CHALLENGE:<nonce>. */
export const clientProof = (token: string, nonce: string): string => hmacHex(token, `client:${nonce}`);
/** What the deck sends in AUTH_OK:<proof>; the client must verify it. */
export const deckProof = (token: string, nonce: string): string => hmacHex(token, `deck:${nonce}`);
/** OTA: auth header value for a given single-use nonce and image hash. */
export const otaProof = (token: string, nonce: string, sha256hex: string): string => hmacHex(token, `ota:${nonce}:${sha256hex}`);
export const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Constant-time compare of two hex strings of any length (different lengths are simply unequal). */
export function ctEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  const len = Math.max(x.length, y.length, 1);
  const px = Buffer.alloc(len), py = Buffer.alloc(len);
  x.copy(px); y.copy(py);
  return timingSafeEqual(px, py) && x.length === y.length;
}
