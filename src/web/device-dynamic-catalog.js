import { randomUUID } from 'node:crypto';
import express from 'express';
import { esc, randomSecret, sha } from './device-core.js';
import { catalogOffset } from './device-history-catalog-content.js';

const PATH = '/devices/dynamic-catalog';
const CATALOGS = {
  movie: { id: 'my-profile-movies', name: 'Meu perfil — Filmes' },
  series: { id: 'my-profile-series', name: 'Meu perfil — Séries' },
};

function profileIdOf(value) {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}

function bindingKey(binding) {
  return sha(JSON.stringify([binding.ip_hash, binding.activated_at, binding.expires_at]));
}

// Use end() so an If-None-Match or If-Modified-Since request cannot turn
// a fresh, network-scoped answer into an Express-generated 304.
const json = (res, status, body) => res.status(status).type('json').end(JSON.stringify(body));

export function createDeviceDynamicCatalog({ db, auth, originOkay, page, config, currentBrowser, matchCatalogNetwork, content }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mp_dynamic_catalog_installs (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      public_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mp_dynamic_catalog_profiles (
      profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      consent_id TEXT NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mp_dynamic_catalog_devices (
      device_id TEXT PRIMARY KEY REFERENCES mp_devices(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL,
      consent_id TEXT NOT NULL,
      revoked_at INTEGER
    );
  `);
  const readInstall = db.prepare('SELECT account_id,public_id FROM mp_dynamic_catalog_installs WHERE token_hash=? AND revoked_at IS NULL');
  const activeInstall = db.prepare('SELECT 1 FROM mp_dynamic_catalog_installs WHERE account_id=? AND revoked_at IS NULL');
  const saveInstall = db.prepare(`INSERT INTO mp_dynamic_catalog_installs (account_id,public_id,token_hash) VALUES (?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash,revoked_at=NULL`);
  const revokeInstall = db.prepare('UPDATE mp_dynamic_catalog_installs SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL');
  const eligible = db.prepare(`SELECT id,name FROM profiles WHERE account_id=? AND deleted_at IS NULL AND passcode_hash IS NULL
    ORDER BY id`);
  const allowProfile = db.prepare(`INSERT INTO mp_dynamic_catalog_profiles (profile_id,account_id,consent_id)
    SELECT id,account_id,? FROM profiles WHERE id=? AND account_id=? AND deleted_at IS NULL AND passcode_hash IS NULL
    ON CONFLICT(profile_id) DO UPDATE SET consent_id=excluded.consent_id,revoked_at=NULL
    WHERE mp_dynamic_catalog_profiles.account_id=excluded.account_id`);
  const revokeProfile = db.prepare(`UPDATE mp_dynamic_catalog_profiles SET revoked_at=?
    WHERE account_id=? AND profile_id=? AND revoked_at IS NULL`);
  const profilesAllowed = db.prepare(`SELECT p.id,p.name,(p.deleted_at IS NULL AND p.passcode_hash IS NULL) AS available
    FROM mp_dynamic_catalog_profiles g
    JOIN profiles p ON p.id=g.profile_id AND p.account_id=g.account_id WHERE g.account_id=? AND g.revoked_at IS NULL ORDER BY p.id`);
  const profileConsent = db.prepare(`SELECT consent_id FROM mp_dynamic_catalog_profiles
    WHERE account_id=? AND profile_id=? AND revoked_at IS NULL`);
  const deviceConsent = db.prepare(`SELECT binding_key,consent_id FROM mp_dynamic_catalog_devices
    WHERE account_id=? AND device_id=? AND revoked_at IS NULL`);
  const allowDevice = db.prepare(`INSERT INTO mp_dynamic_catalog_devices (device_id,account_id,binding_key,consent_id)
    VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET binding_key=excluded.binding_key,consent_id=excluded.consent_id,revoked_at=NULL
    WHERE mp_dynamic_catalog_devices.account_id=excluded.account_id`);
  const revokeDevice = db.prepare(`UPDATE mp_dynamic_catalog_devices SET revoked_at=?
    WHERE account_id=? AND device_id=? AND revoked_at IS NULL`);

  const router = express.Router();
  const addon = express.Router();
  const base = `${config.publicUrl.replace(/\/$/, '')}${PATH}/addon`;
  const csrf = req => `<input type="hidden" name="_csrf" value="${esc(req.session.csrf)}">`;

  function browserBinding(req, accountId, browser, now) {
    if (!browser?.profile_id) return null;
    const match = matchCatalogNetwork(req, accountId, now);
    return match.candidate?.device_id === browser.id && match.candidate.profile_available ? match.candidate : null;
  }

  function dashboard(req, res, issued = '') {
    const accountId = req.session.accountId;
    const now = Date.now();
    const browser = currentBrowser(req, now);
    const binding = browserBinding(req, accountId, browser, now);
    const permission = browser && deviceConsent.get(accountId, browser.id);
    const enabled = binding && permission?.binding_key === bindingKey(binding);
    const profiles = eligible.all(accountId);
    const allowed = profilesAllowed.all(accountId);
    const hasInstall = activeInstall.get(accountId);
    page(res, 'OpenProfiles — Meu perfil', `
      <p>Experimento de leitura. O Stremio sincroniza o add-on pela conta. A rede indica um aparelho provável, e outro aparelho no mesmo IP pode receber o catálogo se o servidor não conseguir distingui-lo.</p>
      <p>Mesmo após troca de perfil ou revogação, o Stremio pode manter itens que já carregou. O link é privado.</p>
      ${issued}
      <h2>1. Autorizar os perfis</h2>
      ${profiles.length ? `<form method="post" action="${PATH}/authorize-profile">${csrf(req)}
        <label>Perfil <select name="profileId" required><option value="">Escolha um perfil</option>
          ${profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
        <label><input type="checkbox" name="consent" value="yes" required> Autorizo a leitura do histórico experimental deste perfil no catálogo por rede.</label>
        <button type="submit">Autorizar perfil</button></form>` : '<p>Nenhum perfil elegível.</p>'}
      ${allowed.length ? `<ul>${allowed.map(p => `<li>${esc(p.name)}${p.available ? '' : ' · perfil indisponível'}
        <form method="post" action="${PATH}/revoke-profile">${csrf(req)}
          <input type="hidden" name="profileId" value="${p.id}"><button type="submit">Revogar perfil</button>
        </form></li>`).join('')}</ul>` : '<p>Nenhum perfil autorizado.</p>'}
      <h2>2. Autorizar esta associação de rede</h2>
      ${enabled ? '<p>Esta associação está autorizada.</p>'
        : binding ? `<form method="post" action="${PATH}/authorize-device">${csrf(req)}
            <label><input type="checkbox" name="consent" value="yes" required> Autorizo o catálogo a usar a associação de rede atual deste navegador pareado.</label>
            <button type="submit">Autorizar esta associação</button></form>`
          : '<p>Nesta rede, o servidor precisa encontrar um único vínculo compatível com este navegador. Confira a <a href="/devices/bridge">associação de rede</a>.</p>'}
      ${permission ? `<form method="post" action="${PATH}/revoke-device">${csrf(req)}
        <button type="submit">Revogar este aparelho</button></form>` : ''}
      <h2>3. Instalar no Stremio</h2>
      <form method="post" action="${PATH}/create-link">${csrf(req)}
        <label><input type="checkbox" name="consent" value="yes" required> Aceito o uso do catálogo experimental na conta Stremio compartilhada.</label>
        <button type="submit">${hasInstall ? 'Substituir link privado' : 'Gerar link privado'}</button></form>
      ${hasInstall ? `<form method="post" action="${PATH}/revoke-link">${csrf(req)}
        <button type="submit">Revogar link do add-on</button></form>` : ''}
      <p><a href="/devices/history-catalog">Catálogos fixos por perfil</a> · <a href="/devices/native-history">Histórico experimental</a></p>`);
  }

  const manage = [auth.require, auth.csrf, originOkay];
  router.get('/', auth.require, (req, res) => dashboard(req, res));
  router.post('/authorize-profile', ...manage, (req, res) => {
    const profileId = profileIdOf(req.body?.profileId);
    if (!profileId || req.body?.consent !== 'yes') return res.status(400).send('Perfil e consentimento obrigatórios.');
    if (!allowProfile.run(randomUUID(), profileId, req.session.accountId).changes) return res.status(404).send('Perfil indisponível.');
    return res.redirect(303, PATH);
  });
  router.post('/revoke-profile', ...manage, (req, res) => {
    const profileId = profileIdOf(req.body?.profileId);
    if (!profileId) return res.status(400).send('Perfil inválido.');
    if (!revokeProfile.run(Date.now(), req.session.accountId, profileId).changes) return res.status(404).send('Autorização indisponível.');
    return res.redirect(303, PATH);
  });
  const authorizeDevice = db.transaction((req, accountId, now) => {
    const browser = currentBrowser(req, now);
    const binding = browserBinding(req, accountId, browser, now);
    return binding && allowDevice.run(browser.id, accountId, bindingKey(binding), randomUUID()).changes;
  });
  router.post('/authorize-device', ...manage, (req, res) => {
    if (req.body?.consent !== 'yes') return res.status(400).send('Consentimento obrigatório.');
    if (!authorizeDevice.immediate(req, req.session.accountId, Date.now())) return res.status(409).send('Associação de rede indisponível para este navegador.');
    return res.redirect(303, PATH);
  });
  router.post('/revoke-device', ...manage, (req, res) => {
    const browser = currentBrowser(req);
    if (!browser) return res.status(404).send('Aparelho indisponível.');
    revokeDevice.run(Date.now(), req.session.accountId, browser.id);
    return res.redirect(303, PATH);
  });
  router.post('/create-link', ...manage, (req, res) => {
    if (req.body?.consent !== 'yes') return res.status(400).send('Consentimento obrigatório.');
    const token = randomSecret();
    saveInstall.run(req.session.accountId, randomUUID(), sha(token));
    const manifest = `${base}/${token}/manifest.json`;
    return dashboard(req, res, `<h2>Link privado do add-on</h2>
      <p>Copie agora. Gerar outro link invalida o anterior.</p>
      <p><code style="overflow-wrap:anywhere">${esc(manifest)}</code></p>
      ${manifest.startsWith('https://') ? `<p><a href="${esc(manifest.replace(/^https:\/\//, 'stremio://'))}">Instalar no Stremio</a></p>` : ''}`);
  });
  router.post('/revoke-link', ...manage, (req, res) => {
    revokeInstall.run(Date.now(), req.session.accountId);
    return res.redirect(303, PATH);
  });

  const installFor = token => /^[A-Za-z0-9_-]{43}$/.test(token) ? readInstall.get(sha(token)) : null;
  function scopeFor(req, install) {
    if (!install) return null;
    const { candidate } = matchCatalogNetwork(req, install.account_id);
    if (!candidate?.profile_available) return null;
    const profile = profileConsent.get(install.account_id, candidate.profile_id);
    const device = deviceConsent.get(install.account_id, candidate.device_id);
    if (!profile || !device || device.binding_key !== bindingKey(candidate)) return null;
    const stamp = sha(JSON.stringify([install.public_id, candidate.device_id, candidate.profile_id, device.consent_id, profile.consent_id]));
    return { account_id: install.account_id, profile_id: candidate.profile_id, stamp };
  }

  const unavailable = res => json(res, 404, { error: 'Catálogo indisponível.' });
  const empty = res => json(res, 200, { metas: [] });
  addon.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Cache-Control': 'private, no-store, max-age=0',
      'CDN-Cache-Control': 'no-store',
      'Surrogate-Control': 'no-store',
      'Vary': '*',
      'Referrer-Policy': 'no-referrer',
    });
    return req.method === 'OPTIONS' ? res.status(204).end() : next();
  });

  addon.get('/:token/manifest.json', (req, res) => {
    const install = installFor(req.params.token);
    if (!install) return unavailable(res);
    return json(res, 200, {
      id: `org.openprofiles.multidevice.dynamic.${install.public_id}`,
      version: '0.8.0',
      name: 'OpenProfiles — Meu perfil',
      description: 'Catálogo experimental por rede. A instalação é sincronizada pela conta Stremio.',
      resources: ['catalog'],
      types: Object.keys(CATALOGS),
      catalogs: Object.entries(CATALOGS).map(([type, catalog]) => ({ type, ...catalog, extra: [{ name: 'skip' }] })),
    });
  });

  async function catalog(req, res) {
    const { token, type, catalogId, extra } = req.params;
    const install = installFor(token);
    if (!install || !Object.hasOwn(CATALOGS, type) || CATALOGS[type].id !== catalogId) return unavailable(res);
    const scope = scopeFor(req, install);
    if (!scope) return empty(res);
    const skip = catalogOffset(extra);
    if (skip === null) return json(res, 400, { metas: [] });
    const metas = await content.list(scope, type, skip,
      id => `${base}/${token}/poster/${scope.stamp}/${type}/${encodeURIComponent(id)}.jpg`);
    const active = installFor(token);
    if (!active) return unavailable(res);
    // The profile or permission can change while metadata is being fetched.
    if (scopeFor(req, active)?.stamp !== scope.stamp) return empty(res);
    return json(res, 200, { metas });
  }
  addon.get('/:token/catalog/:type/:catalogId.json', catalog);
  addon.get('/:token/catalog/:type/:catalogId/:extra.json', catalog);
  addon.get('/:token/poster/:stamp/:type/:titleId.jpg', async (req, res) => {
    const { token, stamp, type, titleId } = req.params;
    const scope = scopeFor(req, installFor(token));
    if (!scope || scope.stamp !== stamp || !Object.hasOwn(CATALOGS, type)) return unavailable(res);
    const bytes = await content.poster(scope, type, titleId);
    if (!bytes || scopeFor(req, installFor(token))?.stamp !== stamp) return unavailable(res);
    return res.type('jpeg').end(bytes);
  });
  addon.use((_req, res) => unavailable(res));
  router.use('/addon', addon);
  return router;
}
