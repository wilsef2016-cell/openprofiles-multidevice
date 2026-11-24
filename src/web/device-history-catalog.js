import { randomUUID } from 'node:crypto';
import express from 'express';
import { esc, randomSecret, sha } from './device-core.js';
import { createHistoryCatalogArtwork } from './device-history-catalog-artwork.js';

const PATH = '/devices/history-catalog';
const CATALOGS = { movie: 'history-movies', series: 'history-series' };
const PAGE_SIZE = 100;
const VIDEO_ID = /^[a-zA-Z0-9:_-]{3,150}$/;

function historyTitleId(type, videoId) {
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return null;
  if (type !== 'series') return videoId;
  const episode = videoId.match(/^(tt\d{5,12}|tmdb:\d+):\d{1,6}:\d{1,6}$/) ??
    videoId.match(/^(kitsu:\d+):\d{1,6}$/);
  return episode?.[1] ?? videoId;
}

function readProfileId(value) {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) ? id : null;
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

export function createDeviceHistoryCatalog({ db, auth, originOkay, page, config, historyCatalogUpstream }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mp_history_catalog_grants (
      profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      public_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
  `);
  db.function('openprofiles_history_title_id', { deterministic: true }, historyTitleId);

  const artwork = createHistoryCatalogArtwork(historyCatalogUpstream);
  const router = express.Router();
  const addon = express.Router();
  const base = `${config.publicUrl.replace(/\/$/, '')}${PATH}/addon`;
  const eligibleProfiles = db.prepare(`SELECT id,name FROM profiles
    WHERE account_id=? AND deleted_at IS NULL AND passcode_hash IS NULL ORDER BY id`);
  const eligibleProfile = db.prepare(`SELECT id FROM profiles
    WHERE account_id=? AND id=? AND deleted_at IS NULL AND passcode_hash IS NULL`);
  const activeGrants = db.prepare(`SELECT g.profile_id,p.name,
      (p.deleted_at IS NULL AND p.passcode_hash IS NULL) AS available
    FROM mp_history_catalog_grants g JOIN profiles p ON p.id=g.profile_id AND p.account_id=g.account_id
    WHERE g.account_id=? AND g.revoked_at IS NULL ORDER BY g.profile_id`);
  const readGrant = db.prepare(`SELECT g.account_id,g.profile_id,g.public_id,p.name
    FROM mp_history_catalog_grants g JOIN profiles p ON p.id=g.profile_id AND p.account_id=g.account_id
    WHERE g.token_hash=? AND g.revoked_at IS NULL AND p.deleted_at IS NULL AND p.passcode_hash IS NULL`);
  const saveGrant = db.prepare(`INSERT INTO mp_history_catalog_grants
    (profile_id,account_id,public_id,token_hash,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(profile_id) DO UPDATE SET token_hash=excluded.token_hash,
      created_at=excluded.created_at,revoked_at=NULL
    WHERE mp_history_catalog_grants.account_id=excluded.account_id`);
  const revokeGrant = db.prepare(`UPDATE mp_history_catalog_grants SET revoked_at=?
    WHERE account_id=? AND profile_id=? AND revoked_at IS NULL`);

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
  const grantFor = token => /^[A-Za-z0-9_-]{43}$/.test(token) ? readGrant.get(sha(token)) : null;

  const csrf = req => `<input type="hidden" name="_csrf" value="${esc(req.session.csrf)}">`;
  function dashboard(req, res, issued = '') {
    const accountId = req.session.accountId;
    const profiles = eligibleProfiles.all(accountId);
    const grants = activeGrants.all(accountId);
    page(res, 'Catálogo de histórico experimental', `
      <p>O Stremio sincroniza os add-ons instalados pela conta. O catálogo pode aparecer em outros aparelhos que usam essa conta.</p>
      <p>Quem tem o link pode ler o histórico experimental do perfil selecionado. Guarde-o em segredo. Revogar bloqueia novas consultas ao servidor. O Stremio pode manter itens já carregados até atualizar o catálogo.</p>
      ${issued}
      <h2>Autorizar catálogo por perfil</h2>
      ${profiles.length ? `<form method="post" action="${PATH}/authorize">${csrf(req)}
        <label>Perfil <select name="profileId" required><option value="">Escolha um perfil</option>
          ${profiles.map(p => `<option value="${p.id}"${String(p.id) === req.query.profileId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></label>
        <label><input type="checkbox" name="consent" value="yes" required> Autorizo a leitura do histórico experimental deste perfil pelo link e entendo que o catálogo pode aparecer em outros aparelhos da conta Stremio.</label>
        <button type="submit">Gerar link privado</button></form>
        <p>Gerar outro link para o mesmo perfil invalida o anterior.</p>` : '<p>Nenhum perfil elegível.</p>'}
      <h2>Links autorizados</h2>
      ${grants.length ? `<ul>${grants.map(g => `<li>${esc(g.name)}${g.available ? '' : ' · perfil indisponível'}
        <form method="post" action="${PATH}/revoke">${csrf(req)}
          <input type="hidden" name="profileId" value="${g.profile_id}"><button type="submit">Revogar link</button>
        </form></li>`).join('')}</ul>` : '<p>Nenhum link ativo.</p>'}
      <p><a href="/devices/native-history">Voltar ao histórico experimental</a></p>`);
  }

  const authorize = db.transaction((accountId, profileId) => {
    if (!eligibleProfile.get(accountId, profileId)) return null;
    const secret = randomSecret();
    if (!saveGrant.run(profileId, accountId, randomUUID(), sha(secret), Date.now()).changes) return null;
    return secret;
  });

  router.get('/', auth.require, (req, res) => dashboard(req, res));
  router.post('/authorize', auth.require, auth.csrf, originOkay, (req, res) => {
    if (req.body?.consent !== 'yes') return res.status(400).send('Consentimento obrigatório.');
    const profileId = readProfileId(req.body?.profileId);
    if (!profileId) return res.status(400).send('Perfil inválido.');
    const token = authorize.immediate(req.session.accountId, profileId);
    if (!token) return res.status(404).send('Perfil indisponível.');
    const manifest = `${base}/${token}/manifest.json`;
    return dashboard(req, res, `<h2>Link privado do catálogo</h2>
      <p>Copie o link agora e instale-o no Stremio. O servidor guarda somente o hash da chave.</p>
      <p><code style="overflow-wrap:anywhere">${esc(manifest)}</code></p>
      ${manifest.startsWith('https://') ? `<p><a href="${esc(manifest.replace(/^https:\/\//, 'stremio://'))}">Instalar no Stremio</a></p>` : ''}`);
  });
  router.post('/revoke', auth.require, auth.csrf, originOkay, (req, res) => {
    const profileId = readProfileId(req.body?.profileId);
    if (!profileId) return res.status(400).send('Perfil inválido.');
    if (!revokeGrant.run(Date.now(), req.session.accountId, profileId).changes) return res.status(404).send('Link indisponível.');
    return res.redirect(303, PATH);
  });

  const unavailable = res => res.status(404).json({ error: 'Catálogo indisponível.' });
  addon.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    return req.method === 'OPTIONS' ? res.status(204).end() : next();
  });

  addon.get('/:token/manifest.json', (req, res) => {
    const grant = grantFor(req.params.token);
    if (!grant) return unavailable(res);
    const name = `OpenProfiles — ${grant.name}`;
    return res.json({
      id: `org.openprofiles.multidevice.history.${grant.public_id}`,
      version: '0.7.0',
      name,
      description: 'Progresso experimental por perfil. A instalação é sincronizada pela conta Stremio.',
      resources: ['catalog'],
      types: Object.keys(CATALOGS),
      catalogs: Object.entries(CATALOGS).map(([type, id]) => ({ type, id, name, extra: [{ name: 'skip' }] })),
    });
  });

  async function catalog(req, res) {
    const { token, type, catalogId, extra } = req.params;
    const grant = grantFor(token);
    if (!grant || !Object.hasOwn(CATALOGS, type) || CATALOGS[type] !== catalogId) return unavailable(res);
    const skips = new URLSearchParams(extra).getAll('skip');
    const rawSkip = skips[0] ?? '0';
    const skip = Number(rawSkip);
    if (skips.length > 1 || !/^\d+$/.test(rawSkip) || !Number.isSafeInteger(skip)) return res.status(400).json({ metas: [] });

    const rows = history.all(grant.account_id, grant.profile_id, type, PAGE_SIZE, skip);
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
          poster: `${base}/${token}/poster/${type}/${encodeURIComponent(row.title_id)}.jpg`,
          posterShape: 'poster',
        };
      }));
    }
    return grantFor(token) ? res.json({ metas }) : unavailable(res);
  }
  addon.get('/:token/catalog/:type/:catalogId.json', catalog);
  addon.get('/:token/catalog/:type/:catalogId/:extra.json', catalog);

  addon.get('/:token/poster/:type/:titleId.jpg', async (req, res) => {
    const { token, type, titleId } = req.params;
    const grant = grantFor(token);
    if (!grant || !Object.hasOwn(CATALOGS, type) || !VIDEO_ID.test(titleId) ||
        !hasTitle.get(grant.account_id, grant.profile_id, type, titleId)) return unavailable(res);
    const poster = await artwork.poster(type, titleId);
    return grantFor(token) ? res.type('jpeg').send(poster) : unavailable(res);
  });

  addon.use((_req, res) => unavailable(res));
  router.use('/addon', addon);
  return router;
}
