import sharp from 'sharp';
import { fetchImageBytes, fetchJson } from '../core/fetchGuard.js';

const IMDB = /^tt\d{5,12}$/;
const CINEMETA = 'https://v3-cinemeta.strem.io';
const METAHUB = 'https://images.metahub.space';
const UPSTREAM_TIMEOUT_MS = 2000;
const POSTER_MAX_BYTES = 1024 * 1024;
const POSTER_WIDTH = 300;
const POSTER_HEIGHT = 450;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function trustedPoster(raw, titleId) {
  if (typeof raw !== 'string' || raw.length > 250) return null;
  // Cinemeta's posters use a fixed MetaHub path for the requested IMDb title.
  const paths = ['small', 'medium', 'large'].map(size => `${METAHUB}/poster/${size}/${titleId}/img`);
  return paths.includes(raw) ? raw : null;
}

function supportedImage(bytes) {
  return Buffer.isBuffer(bytes) && (
    (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
  );
}

/** Coalesces requests and briefly caches failures so an outage degrades to placeholders. */
function cacheLoads(maxEntries, load) {
  const cache = new Map();
  return (key, ...args) => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.result;
    const entry = { expiresAt: Infinity };
    entry.result = load(...args).catch(() => null).then(value => {
      entry.expiresAt = Date.now() + (value ? 60 * 60_000 : 60_000);
      return value;
    });
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return entry.result;
  };
}

export function createHistoryCatalogArtwork({ fetchMetadata = fetchJson, fetchPoster = fetchImageBytes } = {}) {
  const loadTitle = cacheLoads(256, async (type, titleId) => {
    const response = await fetchMetadata(`${CINEMETA}/meta/${type}/${titleId}.json`, { timeoutMs: UPSTREAM_TIMEOUT_MS });
    const meta = response?.meta;
    if (meta?.id !== titleId || meta.type !== type) return null;
    const name = typeof meta.name === 'string' ? meta.name.replace(/\p{Cc}/gu, '').trim().slice(0, 160) : '';
    return { name: name || titleId, poster: trustedPoster(meta.poster, titleId) };
  });

  const loadPoster = cacheLoads(48, async url => {
    const bytes = await fetchPoster(url, { maxBytes: POSTER_MAX_BYTES, timeoutMs: UPSTREAM_TIMEOUT_MS });
    if (!supportedImage(bytes)) return null;
    return sharp(bytes, { limitInputPixels: 8_000_000, pages: 1 }).rotate()
      .resize(POSTER_WIDTH, POSTER_HEIGHT, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
  });

  let placeholder;
  function fallbackPoster() {
    placeholder ??= sharp({ create: {
      width: POSTER_WIDTH, height: POSTER_HEIGHT, channels: 3, background: '#303448',
    } }).jpeg().toBuffer();
    return placeholder;
  }

  async function title(type, titleId) {
    return IMDB.test(titleId) ? loadTitle(`${type}/${titleId}`, type, titleId) : null;
  }

  async function poster(type, titleId) {
    const meta = await title(type, titleId);
    const image = meta?.poster && await loadPoster(meta.poster, meta.poster);
    return image || fallbackPoster();
  }
  return { title, poster };
}
