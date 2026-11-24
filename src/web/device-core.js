import crypto from 'node:crypto';

export const CODE_TTL_MS = 5 * 60_000;
export const DEVICE_TTL_MS = 90 * 24 * 60 * 60_000;
export const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export function pairingCode() {
  // Rejection sampling avoids modulo bias when mapping 5-bit values.
  return Array.from({length: 12}, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}
export function normalizedCode(code) { return String(code ?? '').toUpperCase().replace(/[^A-Z2-9]/g, ''); }
export const esc = str => String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function validProgress(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = String(input.type || '');
  const mediaId = String(input.mediaId || '');
  const videoId = String(input.videoId || mediaId);
  const title = String(input.title || '').trim().slice(0, 120);
  const currentMs = Number(input.currentMs);
  const durationMs = Number(input.durationMs);
  const action = String(input.action || 'pause');
  if (!['movie','series'].includes(kind) || !/^tt\d{5,12}$/.test(mediaId)
    || !/^[a-zA-Z0-9:_-]{3,120}$/.test(videoId) || !title
    || !Number.isFinite(currentMs) || !Number.isFinite(durationMs)
    || currentMs < 0 || durationMs <= 0 || durationMs > 1e10
    || currentMs > durationMs + 120_000 || !['start','pause','stop','ended'].includes(action)) return null;
  return {type:kind, mediaId, videoId, title, currentMs:Math.round(currentMs),durationMs:Math.round(durationMs),action};
}
export function sameSiteRequest(req, publicUrl) {
  const site = req.get('sec-fetch-site');
  if (site && !['same-origin','none'].includes(site)) return false;
  const origin = req.get('origin');
  if (origin && origin !== new URL(publicUrl).origin) return false;
  return true;
}
