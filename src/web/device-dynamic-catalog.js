import { randomUUID } from 'node:crypto';
import express from 'express';
import { esc, randomSecret, sha } from './device-core.js';
import { catalogOffset } from './device-history-catalog-content.js';

const DYNAMIC_PATH = '/devices/dynamic-catalog';
export const UNIFIED_CATALOG_PATH = '/devices/unified-catalog';
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

function createFixedGrants(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mp_unified_catalog_fixed_profiles (
      profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      consent_id TEXT NOT NULL UNIQUE,
      revoked_at INTEGER
    );
  `);
  const allow = db.prepare(`INSERT INTO mp_unified_catalog_fixed_profiles (profile_id,account_id,consent_id)
    SELECT id,account_id,? FROM profiles WHERE id=? AND account_id=? AND deleted_at IS NULL AND passcode_hash IS NULL
    ON CONFLICT(profile_id) DO UPDATE SET
      consent_id=CASE WHEN mp_unified_catalog_fixed_profiles.revoked_at IS NULL
        THEN mp_unified_catalog_fixed_profiles.consent_id ELSE excluded.consent_id END,revoked_at=NULL
    WHERE mp_unified_catalog_fixed_profiles.account_id=excluded.account_id`);
  const revoke = db.prepare(`UPDATE mp_unified_catalog_fixed_profiles SET revoked_at=?
    WHERE account_id=? AND profile_id=? AND revoked_at IS NULL`);
  const list = db.prepare(`SELECT p.id,p.name,g.consent_id,(p.deleted_at IS NULL AND p.passcode_hash IS NULL) AS available
    FROM mp_unified_catalog_fixed_profiles g JOIN profiles p ON p.id=g.profile_id AND p.account_id=g.account_id
    WHERE g.account_id=? AND g.revoked_at IS NULL ORDER BY p.id`);
  const read = db.prepare(`SELECT g.profile_id,g.consent_id FROM mp_unified_catalog_fixed_profiles g
    JOIN profiles p ON p.id=g.profile_id AND p.account_id=g.account_id
    WHERE g.account_id=? AND g.consent_id=? AND g.revoked_at IS NULL AND p.deleted_at IS NULL AND p.passcode_hash IS NULL`);
  return { allow, revoke, list, read };
}

function fixedConsentId(type, catalogId) {
  const prefix = `fixed-${type}-`;
  if (!catalogId.startsWith(prefix)) return null;
  const id = catalogId.slice(prefix.length);
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ? id : null;
}

export function createDeviceDynamicCatalog(options) {
  return createAccountCatalog(options, false);
}

export function createDeviceUnifiedCatalog(options) {
  return createAccountCatalog(options, true);
}

function createAccountCatalog({
  db, auth, originOkay, page, config, currentBrowser, matchCatalogNetwork, content, bindCatalogNetwork, hasCatalogPublicIp, selectDeviceProfile,
}, unified) {
  const path = unified ? UNIFIED_CATALOG_PATH : DYNAMIC_PATH;
  const name = unified ? 'OpenProfiles MultiDevice' : 'OpenProfiles — Meu perfil';
  // Separate namespaces keep legacy installation and authorization state untouched.
  const tables = unified ? 'mp_unified_catalog' : 'mp_dynamic_catalog';
  const fixed = unified ? createFixedGrants(db) : null;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tables}_installs (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      public_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ${tables}_profiles (
      profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      consent_id TEXT NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ${tables}_devices (
      device_id TEXT PRIMARY KEY REFERENCES mp_devices(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL,
      consent_id TEXT NOT NULL,
      revoked_at INTEGER
    );
  `);
  const readInstall = db.prepare(`SELECT account_id,public_id FROM ${tables}_installs WHERE token_hash=? AND revoked_at IS NULL`);
  const activeInstall = db.prepare(`SELECT 1 FROM ${tables}_installs WHERE account_id=? AND revoked_at IS NULL`);
  const saveInstall = db.prepare(`INSERT INTO ${tables}_installs (account_id,public_id,token_hash) VALUES (?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash,revoked_at=NULL`);
  const revokeInstall = db.prepare(`UPDATE ${tables}_installs SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL`);
  const eligible = db.prepare(`SELECT id,name FROM profiles WHERE account_id=? AND deleted_at IS NULL AND passcode_hash IS NULL
    ORDER BY id`);
  const allowProfile = db.prepare(`INSERT INTO ${tables}_profiles (profile_id,account_id,consent_id)
    SELECT id,account_id,? FROM profiles WHERE id=? AND account_id=? AND deleted_at IS NULL AND passcode_hash IS NULL
    ON CONFLICT(profile_id) DO UPDATE SET consent_id=excluded.consent_id,revoked_at=NULL
    WHERE ${tables}_profiles.account_id=excluded.account_id`);
  const revokeProfile = db.prepare(`UPDATE ${tables}_profiles SET revoked_at=?
    WHERE account_id=? AND profile_id=? AND revoked_at IS NULL`);
  const profilesAllowed = db.prepare(`SELECT p.id,p.name,(p.deleted_at IS NULL AND p.passcode_hash IS NULL) AS available
    FROM ${tables}_profiles g
    JOIN profiles p ON p.id=g.profile_id AND p.account_id=g.account_id WHERE g.account_id=? AND g.revoked_at IS NULL ORDER BY p.id`);
  const profileConsent = db.prepare(`SELECT consent_id FROM ${tables}_profiles
    WHERE account_id=? AND profile_id=? AND revoked_at IS NULL`);
  const deviceConsent = db.prepare(`SELECT binding_key,consent_id FROM ${tables}_devices
    WHERE account_id=? AND device_id=? AND revoked_at IS NULL`);
  const allowDevice = db.prepare(`INSERT INTO ${tables}_devices (device_id,account_id,binding_key,consent_id)
    VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET binding_key=excluded.binding_key,consent_id=excluded.consent_id,revoked_at=NULL
    WHERE ${tables}_devices.account_id=excluded.account_id`);
  const revokeDevice = db.prepare(`UPDATE ${tables}_devices SET revoked_at=?
    WHERE account_id=? AND device_id=? AND revoked_at IS NULL`);

  const router = express.Router();
  const addon = express.Router();
  const base = `${config.publicUrl.replace(/\/$/, '')}${path}/addon`;
  const csrf = req => `<input type="hidden" name="_csrf" value="${esc(req.session.csrf)}">`;
  const options = (profiles, selected) => profiles.map(p =>
    `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('');

  function profileControls(req, profiles, grants, mode, consent) {
    return `${profiles.length ? `<form method="post" action="${path}/authorize-${mode}">${csrf(req)}
      <label>Perfil <select name="profileId" required><option value="">Escolha um perfil</option>${options(profiles)}</select></label>
      <label><input type="checkbox" name="consent" value="yes" required> ${consent}</label>
      <button type="submit">Autorizar perfil</button></form>` : '<p>Nenhum perfil elegível.</p>'}
      ${grants.length ? `<ul>${grants.map(p => `<li>${esc(p.name)}${p.available ? '' : ' · perfil indisponível'}
        <form method="post" action="${path}/revoke-${mode}">${csrf(req)}
          <input type="hidden" name="profileId" value="${p.id}"><button type="submit">Revogar perfil</button>
        </form></li>`).join('')}</ul>` : '<p>Nenhum perfil autorizado.</p>'}`;
  }

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
    const flash = unified ? auth.takeFlash(req) : null;
    page(res, name, `
      <p>Experimento de leitura. O Stremio sincroniza o add-on pela conta. A rede indica um aparelho provável, e outro aparelho no mesmo IP pode receber o catálogo se o servidor não conseguir distingui-lo.</p>
      <p>Mesmo após troca de perfil ou revogação, o Stremio pode manter itens que já carregou. O link é privado.</p>
      ${flash ? `<p role="status">${esc(flash.text)}</p>` : ''}
      ${issued}
      ${unified ? `<h2>Perfil deste navegador</h2>
        ${browser && profiles.length ? `<form method="post" action="${path}/select-profile">${csrf(req)}
          <label>Perfil <select name="profileId" required><option value="">Escolha um perfil</option>${options(profiles, browser.profile_id)}</select></label>
          <button type="submit">Usar neste aparelho</button></form>`
          : '<p>Use um <a href="/devices">navegador pareado</a> com um perfil elegível para o modo automático.</p>'}` : ''}
      <h2>Autorizações do modo automático</h2>
      ${profileControls(req, profiles, allowed, 'profile', 'Autorizo a leitura do histórico experimental deste perfil no catálogo por rede.')}
      ${fixed ? `<h2>Catálogos fixos</h2>
        <p>Um catálogo fixo autorizado pode ser visto por outros aparelhos da mesma conta Stremio, independentemente do perfil selecionado neles.</p>
        ${profileControls(req, profiles, fixed.list.all(accountId), 'fixed', 'Autorizo a exibição deste perfil em catálogos fixos para quem tem acesso ao link do add-on unificado.')}` : ''}
      <h2>Associação de rede deste aparelho</h2>
      ${unified ? '<p><a href="/devices/unified-catalog/network-diagnostic">Diagnóstico de rede deste navegador</a></p>' : ''}
      ${unified && browser?.profile_id ? `<form method="post" action="${path}/bind-device">${csrf(req)}
        <label><input type="checkbox" name="consent" value="yes" required> Autorizo associar a rede atual ao navegador. Uma mudança de rede substitui o vínculo compartilhado com as versões anteriores.</label>
        <button type="submit">Associar rede atual</button></form>` : ''}
      ${enabled ? '<p>Esta associação está autorizada.</p>'
        : binding ? `<form method="post" action="${path}/authorize-device">${csrf(req)}
            <label><input type="checkbox" name="consent" value="yes" required> Autorizo o catálogo a usar a associação de rede atual deste navegador pareado.</label>
            <button type="submit">Autorizar esta associação</button></form>`
          : '<p>Nesta rede, o servidor precisa encontrar um único vínculo compatível com este navegador. Confira a <a href="/devices/bridge">associação de rede</a>.</p>'}
      ${permission ? `<form method="post" action="${path}/revoke-device">${csrf(req)}
        <button type="submit">Revogar este aparelho</button></form>` : ''}
      <h2>Instalar no Stremio</h2>
      <form method="post" action="${path}/create-link">${csrf(req)}
        <label><input type="checkbox" name="consent" value="yes" required> Aceito o uso do catálogo experimental na conta Stremio compartilhada.</label>
        <button type="submit">${hasInstall ? 'Substituir link privado' : 'Gerar link privado'}</button></form>
      ${hasInstall ? `<form method="post" action="${path}/revoke-link">${csrf(req)}
        <button type="submit">Revogar link do add-on</button></form>` : ''}
      <p><a href="/devices/history-catalog">Catálogos v0.7</a> · ${unified ? `<a href="${DYNAMIC_PATH}">Catálogo v0.8</a>` : `<a href="${UNIFIED_CATALOG_PATH}">Add-on unificado</a>`} · <a href="/devices/native-history">Histórico experimental</a></p>`);
  }

  const manage = [auth.require, auth.csrf, originOkay];
  router.get('/', auth.require, (req, res) => dashboard(req, res));
  function manageProfiles(mode, allow, revoke) {
    router.post(`/authorize-${mode}`, ...manage, (req, res) => {
      const profileId = profileIdOf(req.body?.profileId);
      if (!profileId || req.body?.consent !== 'yes') return res.status(400).send('Perfil e consentimento obrigatórios.');
      if (!allow.run(randomUUID(), profileId, req.session.accountId).changes) return res.status(404).send('Perfil indisponível.');
      return res.redirect(303, path);
    });
    router.post(`/revoke-${mode}`, ...manage, (req, res) => {
      const profileId = profileIdOf(req.body?.profileId);
      if (!profileId) return res.status(400).send('Perfil inválido.');
      if (!revoke.run(Date.now(), req.session.accountId, profileId).changes) return res.status(404).send('Autorização indisponível.');
      return res.redirect(303, path);
    });
  }
  manageProfiles('profile', allowProfile, revokeProfile);
  if (fixed) {
    manageProfiles('fixed', fixed.allow, fixed.revoke);
    router.post('/select-profile', ...manage, (req, res) => selectDeviceProfile(req, res, path));
    function networkDiagnostic(req, res, browser, status = 200) {
      const hasPublicIp = hasCatalogPublicIp(req);
      return page(res, 'Diagnóstico de rede', `
        <ul>
          <li>Navegador pareado nesta conta · ${browser ? 'Sim' : 'Não'}</li>
          <li>Perfil elegível selecionado · ${browser?.profile_id ? 'Sim' : 'Não'}</li>
          <li>IP público resolvido por uma origem confiável · ${hasPublicIp ? 'Sim' : 'Não'}</li>
        </ul>
        ${hasPublicIp ? '' : '<p>O modo automático está indisponível nesta rede. Os catálogos fixos autorizados continuam disponíveis.</p>'}
        <p><a href="${path}">Voltar ao OpenProfiles MultiDevice</a></p>`, status);
    }
    router.get('/network-diagnostic', auth.require, (req, res) => networkDiagnostic(req, res, currentBrowser(req)));
    const bindDevice = db.transaction(req => {
      const now = Date.now();
      const browser = currentBrowser(req, now);
      const bound = browser?.profile_id && bindCatalogNetwork(req, { id: browser.id, account_id: req.session.accountId }, now);
      return { browser, bound };
    });
    router.post('/bind-device', ...manage, (req, res) => {
      if (req.body?.consent !== 'yes') return res.status(400).send('Consentimento obrigatório.');
      const { browser, bound } = bindDevice.immediate(req);
      if (!bound) return networkDiagnostic(req, res, browser, 409);
      return res.redirect(303, path);
    });
  }
  const authorizeDevice = db.transaction((req, accountId, now) => {
    const browser = currentBrowser(req, now);
    const binding = browserBinding(req, accountId, browser, now);
    return binding && allowDevice.run(browser.id, accountId, bindingKey(binding), randomUUID()).changes;
  });
  router.post('/authorize-device', ...manage, (req, res) => {
    if (req.body?.consent !== 'yes') return res.status(400).send('Consentimento obrigatório.');
    if (!authorizeDevice.immediate(req, req.session.accountId, Date.now())) return res.status(409).send('Associação de rede indisponível para este navegador.');
    return res.redirect(303, path);
  });
  router.post('/revoke-device', ...manage, (req, res) => {
    const browser = currentBrowser(req);
    if (!browser) return res.status(404).send('Aparelho indisponível.');
    revokeDevice.run(Date.now(), req.session.accountId, browser.id);
    return res.redirect(303, path);
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
    return res.redirect(303, path);
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

  function fixedScope(install, consentId) {
    if (!fixed || !install || !consentId) return null;
    const grant = fixed.read.get(install.account_id, consentId);
    if (!grant) return null;
    const stamp = sha(JSON.stringify([install.public_id, grant.profile_id, grant.consent_id]));
    return { account_id: install.account_id, profile_id: grant.profile_id, stamp };
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
    const catalogs = Object.entries(CATALOGS).map(([type, catalog]) => ({ type, ...catalog, extra: [{ name: 'skip' }] }));
    if (fixed) {
      for (const profile of fixed.list.all(install.account_id)) {
        if (!profile.available) continue;
        for (const type of Object.keys(CATALOGS)) {
          catalogs.push({ type, id: `fixed-${type}-${profile.consent_id}`,
            name: `OpenProfiles — ${profile.name} — ${type === 'movie' ? 'Filmes' : 'Séries'}`, extra: [{ name: 'skip' }] });
        }
      }
    }
    return json(res, 200, {
      id: `org.openprofiles.multidevice.${unified ? 'unified' : 'dynamic'}.${install.public_id}`,
      version: unified ? '0.9.1' : '0.8.0',
      name,
      description: unified ? 'Histórico experimental com catálogos por rede e perfis autorizados. A instalação é sincronizada pela conta Stremio.'
        : 'Catálogo experimental por rede. A instalação é sincronizada pela conta Stremio.',
      resources: ['catalog'],
      types: Object.keys(CATALOGS),
      catalogs,
    });
  });

  async function catalog(req, res) {
    const { token, type, catalogId, extra } = req.params;
    const install = installFor(token);
    if (!install || !Object.hasOwn(CATALOGS, type)) return unavailable(res);
    const consentId = fixed && fixedConsentId(type, catalogId);
    if (CATALOGS[type].id !== catalogId && !consentId) return unavailable(res);
    // A fixed catalog is selected explicitly by its ID. Automatic requests
    // always use the network scope, even when a fixed grant is available.
    const resolve = active => consentId ? fixedScope(active, consentId) : scopeFor(req, active);
    const scope = resolve(install);
    if (!scope) return empty(res);
    const skip = catalogOffset(extra);
    if (skip === null) return json(res, 400, { metas: [] });
    const posterBase = consentId ? `${base}/${token}/poster/fixed/${catalogId}` : `${base}/${token}/poster`;
    const metas = await content.list(scope, type, skip,
      id => `${posterBase}/${scope.stamp}/${type}/${encodeURIComponent(id)}.jpg`);
    const active = installFor(token);
    if (!active) return unavailable(res);
    // The profile or permission can change while metadata is being fetched.
    if (resolve(active)?.stamp !== scope.stamp) return empty(res);
    return json(res, 200, { metas });
  }
  addon.get('/:token/catalog/:type/:catalogId.json', catalog);
  addon.get('/:token/catalog/:type/:catalogId/:extra.json', catalog);
  async function poster(req, res) {
    const { token, stamp, type, titleId, catalogId } = req.params;
    if (!Object.hasOwn(CATALOGS, type)) return unavailable(res);
    const resolve = active => catalogId ? fixedScope(active, fixedConsentId(type, catalogId)) : scopeFor(req, active);
    const scope = resolve(installFor(token));
    if (!scope || scope.stamp !== stamp) return unavailable(res);
    const bytes = await content.poster(scope, type, titleId);
    if (!bytes || resolve(installFor(token))?.stamp !== stamp) return unavailable(res);
    return res.type('jpeg').end(bytes);
  }
  addon.get('/:token/poster/:stamp/:type/:titleId.jpg', poster);
  if (fixed) addon.get('/:token/poster/fixed/:catalogId/:stamp/:type/:titleId.jpg', poster);
  addon.use((_req, res) => unavailable(res));
  router.use('/addon', addon);
  return router;
}
