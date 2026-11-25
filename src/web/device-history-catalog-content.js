import { createHistoryCatalogArtwork } from './device-history-catalog-artwork.js';

const PAGE_SIZE = 100;
const VIDEO_ID = /^[a-zA-Z0-9:_-]{3,150}$/;

function historyTitleId(type, videoId) {
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return null;
  if (type !== 'series') return videoId;
  const episode = videoId.match(/^(tt\d{5,12}|tmdb:\d+):\d{1,6}:\d{1,6}$/) ??
    videoId.match(/^(kitsu:\d+):\d{1,6}$/);
  return episode?.[1] ?? videoId;
}

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const pad = n => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

function progressLabel(row) {
  const suffix = row.video_id === row.title_id ? [] : row.video_id.slice(row.title_id.length + 1).split(':').map(Number);
  const episode = suffix.length === 2 ? `T${suffix[0]}E${suffix[1]} · ` : suffix.length ? `Ep. ${suffix[0]} · ` : '';
  return `${episode}${formatTime(row.position_ms)} / ${formatTime(row.duration_ms)}`;
}

export function catalogOffset(extra) {
  const skips = new URLSearchParams(extra).getAll('skip');
  const rawSkip = skips[0] ?? '0';
  const skip = Number(rawSkip);
  return skips.length <= 1 && /^\d+$/.test(rawSkip) && Number.isSafeInteger(skip) ? skip : null;
}

/** Read experimental history and cache only public title metadata and artwork. */
export function createHistoryCatalogContent({ db, historyCatalogUpstream }) {
  db.function('openprofiles_history_title_id', { deterministic: true }, historyTitleId);
  const artwork = createHistoryCatalogArtwork(historyCatalogUpstream);
  // Rank the best position within each video, then represent a series by its most recently recorded episode.
  const history = db.prepare(`
    WITH videos AS (
      SELECT video_id,duration_ms,MIN(current_ms,duration_ms) AS position_ms,
        openprofiles_history_title_id(type,video_id) AS title_id,
        MAX(source_event_id) OVER (PARTITION BY video_id) AS activity,
        ROW_NUMBER() OVER (
          PARTITION BY video_id ORDER BY MIN(current_ms,duration_ms) DESC,source_event_id DESC
        ) AS best
      FROM mp_native_history_events
      WHERE account_id=? AND profile_id=? AND type=? AND undone_at IS NULL
    ), titles AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY title_id ORDER BY activity DESC) AS latest
      FROM videos WHERE best=1 AND title_id IS NOT NULL
    )
    SELECT title_id,video_id,duration_ms,position_ms FROM titles WHERE latest=1
    ORDER BY activity DESC LIMIT ? OFFSET ?
  `);
  const hasTitle = db.prepare(`SELECT 1 FROM mp_native_history_events
    WHERE account_id=? AND profile_id=? AND type=? AND undone_at IS NULL
      AND openprofiles_history_title_id(type,video_id)=? LIMIT 1`);

  async function list({ account_id: accountId, profile_id: profileId }, type, skip, posterUrl) {
    const rows = history.all(accountId, profileId, type, PAGE_SIZE, skip);
    const metas = [];
    const deadline = Date.now() + 3000;
    for (let i = 0; i < rows.length; i += 10) {
      const batch = rows.slice(i, i + 10);
      const titles = Date.now() < deadline ? await Promise.all(batch.map(row => artwork.title(type, row.title_id))) : [];
      metas.push(...batch.map((row, index) => {
        const title = titles[index]?.name ?? row.title_id;
        const progress = progressLabel(row);
        return {
          id: row.title_id,
          type,
          name: `${title} · ${progress}`,
          description: `Progresso experimental OpenProfiles · ${progress}`,
          poster: posterUrl(row.title_id),
          posterShape: 'poster',
        };
      }));
    }
    return metas;
  }

  async function poster({ account_id: accountId, profile_id: profileId }, type, titleId) {
    if (!VIDEO_ID.test(titleId) || !hasTitle.get(accountId, profileId, type, titleId)) return null;
    return artwork.poster(type, titleId);
  }

  return { list, poster };
}
