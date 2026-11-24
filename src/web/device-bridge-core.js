import crypto from 'node:crypto';
import { isIP } from 'node:net';

export const NETWORK_TTL_MS = 24 * 60 * 60 * 1000;

/** Privacy: reject local/non-routable request addresses (proxy loopback, LAN). */
export function publicIp(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase().replace(/^::ffff:/, '');
  const kind = isIP(candidate);
  if (!kind) return null;
  if (kind === 4) {
    const [a,b] = candidate.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19))) return null;
  } else {
    if (candidate === '::' || candidate === '::1' ||
        /^(fc|fd|fe[89ab])/.test(candidate) ||
        candidate.startsWith('2001:db8:')) return null;
  }
  return candidate;
}

export function networkDigest(secret, ip) {
  const normalized = publicIp(ip);
  if (!normalized) return null;
  return crypto.createHmac('sha256', secret).update(`openprofiles-v04-ip:${normalized}`).digest('hex');
}

/** Unique network match means CANDIDATE only; neither device nor player is verified. */
export function candidateForNetwork(bindings, eventHash, now) {
  if (!eventHash) return { status: 'unavailable', candidate: null };
  const candidates = bindings.filter(b => b.ip_hash === eventHash &&
    b.expires_at > now && b.device_expires_at > now && b.revoked_at === null);
  if (candidates.length === 0) return { status: 'unmatched', candidate: null };
  if (candidates.length > 1) return { status: 'ambiguous', candidate: null };
  return { status: 'possible', candidate: candidates[0] };
}
