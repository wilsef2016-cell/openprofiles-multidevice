import { randomUUID } from 'node:crypto';
import express from 'express';
import { esc, randomSecret, sha } from './device-core.js';
import { catalogOffset } from './device-history-catalog-content.js';

const PATH = '/devices/history-catalog';
const CATALOGS = { movie: 'history-movies', series: 'history-series' };
function readProfileId(value) {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}

export function createDeviceHistoryCatalog({ db, auth, originOkay, page, config, content }) {
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
  const router = express.Router();
  const addon = express.Router();
  const base = `${config.publicUrl.replace(/\/$/, '')}${PATH}/addon`;
  const eligibleProfiles = db.prepare(`SELECT id,name FROM profiles
    WHERE account_id=? AND deleted_at IS NULL AND passcode_hash IS NULL ORDER BY id`);
  const eligibleProfile = db.prepare(`SELECT id FROM profiles
    WHERE account_id=? AND id=? AND deleted_at IS NULL AND passcode_hash IS NULL`);
  const profileGrants = db.prepare(`SELECT g.profile_id,p.name,g.revoked_at IS NULL AS active,
      (p.deleted_at IS NULL AND p.passcode_hash IS NULL) AS available
    FROM mp_history_catalog_grants g JOIN profiles p ON p.id=g.profile_id AND p.account_id=g.account_id
    WHERE g.account_id=? ORDER BY g.profile_id`);
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

  const grantFor = token => /^[A-Za-z0-9_-]{43}$/.test(token) ? readGrant.get(sha(token)) : null;

  const csrf = req => `<input type="hidden" name="_csrf" value="${esc(req.session.csrf)}">`;
  function dashboard(req, res, issued = '') {
    const accountId = req.session.accountId;
    const profiles = eligibleProfiles.all(accountId);
    const grants = profileGrants.all(accountId);
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
      <h2>Estado dos links v0.7</h2>
      <p>Um link antigo pode retornar 404 se a chave foi substituída ou revogada, se o perfil está indisponível ou se o Stremio usa um endereço de catálogo diferente do manifesto.</p>
      ${grants.length ? `<ul>${grants.map(g => `<li>${esc(g.name)} · ${g.active ? (g.available ? 'link ativo' : 'perfil indisponível') : 'link revogado'}
        ${g.active ? `<form method="post" action="${PATH}/revoke">${csrf(req)}
          <input type="hidden" name="profileId" value="${g.profile_id}"><button type="submit">Revogar link</button>
        </form>` : ''}</li>`).join('')}</ul>` : '<p>Nenhum link ativo.</p>'}
      <p><a href="/devices/native-history">Voltar ao histórico experimental</a> · <a href="/devices/dynamic-catalog">Configurar Meu perfil</a> · <a href="/devices/unified-catalog">Add-on unificado</a></p>`);
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
    const skip = catalogOffset(extra);
    if (skip === null) return res.status(400).json({ metas: [] });

    const metas = await content.list(grant, type, skip,
      id => `${base}/${token}/poster/${type}/${encodeURIComponent(id)}.jpg`);
    return grantFor(token) ? res.json({ metas }) : unavailable(res);
  }
  addon.get('/:token/catalog/:type/:catalogId.json', catalog);
  addon.get('/:token/catalog/:type/:catalogId/:extra.json', catalog);

  addon.get('/:token/poster/:type/:titleId.jpg', async (req, res) => {
    const { token, type, titleId } = req.params;
    const grant = grantFor(token);
    if (!grant || !Object.hasOwn(CATALOGS, type)) return unavailable(res);
    const poster = await content.poster(grant, type, titleId);
    return poster && grantFor(token) ? res.type('jpeg').send(poster) : unavailable(res);
  });

  addon.use((_req, res) => unavailable(res));
  router.use('/addon', addon);
  return router;
}
