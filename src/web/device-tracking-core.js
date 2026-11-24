import crypto from 'node:crypto';

// No device identity is available in native tracking requests.
export const TRACKING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const TRACKING_MAX_EVENTS_PER_ACCOUNT = 200;
export function digestToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}
export function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}
export function nativeManifest(token) {
  return {
    id: `org.openprofiles.multidevice.tracking.${digestToken(token).slice(0,16)}`,
    version: '0.3.0',
    name: 'OpenProfiles - Rastreamento experimental',
    description: 'Recebe eventos de reproducao desta conta Stremio para diagnostico. Nao identifica aparelhos nem altera os historicos dos perfis.',
    resources: [{ name: 'player', types: ['movie', 'series'] }],
    types: ['movie','series'],
    catalogs: [],
  };
}
export function parseNativeEvent(type, videoId, extras) {
  if (!['movie','series'].includes(type) ||
      typeof videoId !== 'string' || !/^[a-zA-Z0-9:_-]{3,150}$/.test(videoId) ||
      typeof extras !== 'string' || extras.length > 500) return null;
  const params = new URLSearchParams(extras);
  if (['action','currentTime','duration'].some(name => params.getAll(name).length !== 1)) return null;
  const action = params.get('action');
  const current = params.get('currentTime');
  const duration = params.get('duration');
  if (!['start','pause','stop'].includes(action) || !/^\d{1,14}$/.test(current || '') ||
      !/^\d{1,14}$/.test(duration || '')) return null;
  const currentMs = Number(current);
  const durationMs = Number(duration);
  if (!Number.isSafeInteger(currentMs) || !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 || durationMs > 1e10 || currentMs < 0 ||
      currentMs > durationMs + 120000) return null;
  return { type, videoId, action, currentMs, durationMs };
}
