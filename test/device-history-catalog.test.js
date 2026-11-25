import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { AccountsService } from '../src/core/accounts.js';
import { Settings } from '../src/core/settings.js';
import { openDatabase } from '../src/db.js';
import { sha } from '../src/web/device-core.js';
import { silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { Browser } from './helpers/browser.js';
import { linkedWithKids } from './helpers/setup.js';

const PAGE = '/devices/history-catalog';
const MATRIX = 'tt0133093';
const THRONES = 'tt0944947';
const missingMeta = 'tt0000000';
const unsafePoster = 'tt0000001';
const missingPoster = 'tt0000002';
const kidsOnlyMovie = 'tt0110357';
const imdbPoster = id => `https://images.metahub.space/poster/small/${id}/img`;
const catalogPath = (url, type = 'movie') => `${url}/catalog/${type}/history-${type === 'movie' ? 'movies' : 'series'}.json`;

async function fixture(t, { trustProxy = false, catalogRailwayEdgeOnly = false, onMetadata } = {}) {
  const previous = process.env.MULTIDEVICE_MODE;
  process.env.MULTIDEVICE_MODE = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.MULTIDEVICE_MODE;
    else process.env.MULTIDEVICE_MODE = previous;
  });
  const ctx = await linkedWithKids({ access: { mode: 'open' }, withAddon: true });
  const { db, accounts, settings, repo, original, kids } = ctx;
  const metadataRequests = [];
  const posterRequests = [];
  const cover = await sharp({ create: { width: 64, height: 96, channels: 3, background: '#dc1e28' } }).png().toBuffer();
  const historyCatalogUpstream = {
    async fetchMetadata(url) {
      metadataRequests.push(url);
      if (onMetadata) await onMetadata(url);
      const [, , type, end] = new URL(url).pathname.split('/');
      const id = end.replace(/\.json$/, '');
      if (id === missingMeta) throw new Error('Cinemeta temporarily unavailable');
      const titles = { [MATRIX]: 'The Matrix', [THRONES]: 'Game of Thrones', [kidsOnlyMovie]: 'The Lion King' };
      return { meta: {
        id, type, name: titles[id] ?? 'Obra sem capa',
        poster: id === unsafePoster ? 'https://127.0.0.1/private.jpg' : imdbPoster(id),
      } };
    },
    async fetchPoster(url) {
      posterRequests.push(url);
      if (url === imdbPoster(missingPoster)) throw new Error('Image not found');
      return cover;
    },
  };
  const config = { publicUrl: 'https://profiles.example.com', trustProxy, catalogRailwayEdgeOnly };
  const app = createApp({ config, db, accounts, settings, log: silentLogger, historyCatalogUpstream });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(() => { db.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = new Browser(base);
  assert.equal((await owner.signIn()).status, 303);

  const addDevice = db.prepare(`INSERT INTO mp_devices
    (id,account_id,profile_id,label,token_hash,created_at,expires_at) VALUES (?,?,?,'Fixture',?,?,?)`);
  const addHistory = db.prepare(`INSERT INTO mp_native_history_events
    (source_event_id,account_id,device_id,profile_id,context_id,playback_id,type,video_id,action,current_ms,duration_ms,received_at,undone_at)
    VALUES (@id,@accountId,@deviceId,@profileId,'fixture',@id,@type,@videoId,'stop',@position,@duration,@id,@undoneAt)`);
  const devices = new Map();
  let eventId = 0;

  async function pair(browser, profile, label) {
    const pairing = await browser.post('/devices/new-pair', { profileId: profile.id, label });
    assert.equal(pairing.status, 200);
    const code = pairing.text.match(/<h2><code>([A-Z0-9]+)<\/code><\/h2>/)[1];
    assert.equal((await browser.request('/devices/activate', { method: 'POST', form: { code } })).location, '/devices/me');
    devices.set(profile.id, db.prepare('SELECT id FROM mp_devices WHERE label=?').pluck().get(label));
  }

  function add(profile, videoId, position, { type = 'movie', duration = 7_200_000, undoneAt = null } = {}) {
    const accountId = db.prepare('SELECT account_id FROM profiles WHERE id=?').pluck().get(profile.id);
    let deviceId = devices.get(profile.id);
    if (!deviceId) {
      deviceId = randomUUID();
      devices.set(profile.id, deviceId);
      addDevice.run(deviceId, accountId, profile.id, sha(deviceId), Date.now(), Date.now() + 60_000);
    }
    addHistory.run({ id: ++eventId, accountId, deviceId, profileId: profile.id, type, videoId, position, duration, undoneAt });
  }

  async function authorize(browser, profile) {
    const res = await browser.post(`${PAGE}/authorize`, { profileId: profile.id, consent: 'yes' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const token = res.text.match(/\/devices\/history-catalog\/addon\/([a-zA-Z0-9_-]{43})\/manifest\.json/)[1];
    return { token, url: `${base}${PAGE}/addon/${token}` };
  }
  async function metas(url, type = 'movie') {
    const res = await fetch(catalogPath(url, type));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    return (await res.json()).metas;
  }
  return { ...ctx, repo, original, kids, config, historyCatalogUpstream, metadataRequests, posterRequests, owner, base, add, authorize, metas, pair };
}

test('catalog reads independent progress for two profiles using a catalog-only manifest and canonical IDs', async (t) => {
  const { db, fake, owner, original, kids, config, add, authorize, metas, metadataRequests, posterRequests } = await fixture(t);
  add(original, MATRIX, 193000);
  add(original, MATRIX, 32000); // An out-of-order, smaller position cannot replace the highest.
  add(original, MATRIX, 5400000, { undoneAt: 1 });
  add(kids, MATRIX, 12000);
  add(kids, kidsOnlyMovie, 66000);
  const before = db.prepare('SELECT * FROM mp_native_history_events ORDER BY source_event_id').all();
  const beforeCalls = fake.calls.length;
  const originalLink = await authorize(owner, original);
  const kidsLink = await authorize(owner, kids);
  assert.notEqual(originalLink.token, kidsLink.token);

  const originalManifest = await fetch(`${originalLink.url}/manifest.json`).then(r => r.json());
  const kidsManifest = await fetch(`${kidsLink.url}/manifest.json`).then(r => r.json());
  assert.notEqual(originalManifest.id, kidsManifest.id);
  assert.deepEqual(originalManifest.resources, ['catalog']);
  assert.deepEqual(originalManifest.catalogs.map(c => [c.type, c.name]), [
    ['movie', 'OpenProfiles — Original'], ['series', 'OpenProfiles — Original'],
  ]);
  assert.ok(kidsManifest.catalogs.every(c => c.name === 'OpenProfiles — Kids'));

  const originalMovies = await metas(originalLink.url);
  assert.deepEqual(originalMovies.map(m => m.id), [MATRIX]);
  assert.equal(originalMovies[0].name, 'The Matrix · 3:13 / 2:00:00');
  assert.match(originalMovies[0].description, /Progresso experimental OpenProfiles/);
  assert.equal(originalMovies[0].posterShape, 'poster');
  const kidsMovies = await metas(kidsLink.url);
  assert.deepEqual(kidsMovies.map(m => m.id), [kidsOnlyMovie, MATRIX]);
  assert.equal(kidsMovies[1].name, 'The Matrix · 0:12 / 2:00:00');
  assert.equal(metadataRequests.filter(url => url.endsWith(`/${MATRIX}.json`)).length, 1, 'public title metadata is reused');

  const coverPath = new URL(originalMovies[0].poster).pathname;
  const cover = await fetch(`${originalLink.url.split(PAGE)[0]}${coverPath}`);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  const coverImage = await sharp(Buffer.from(await cover.arrayBuffer())).metadata();
  assert.equal(coverImage.width, 300);
  assert.equal(coverImage.height, 450);
  assert.deepEqual(posterRequests, [imdbPoster(MATRIX)]);
  assert.equal(new URL(originalMovies[0].poster).origin, config.publicUrl);

  for (const resource of ['stream/movie', 'meta/movie', 'library/movie', 'player/movie']) {
    assert.equal((await fetch(`${originalLink.url}/${resource}/${MATRIX}.json`)).status, 404);
  }
  assert.deepEqual(db.prepare('SELECT * FROM mp_native_history_events ORDER BY source_event_id').all(), before);
  assert.equal(fake.calls.length, beforeCalls);
});

test('catalog groups known episode IDs by series and shows the most recent episode progress', async (t) => {
  const { original, owner, add, authorize, metas, metadataRequests } = await fixture(t);
  const series = { type: 'series', duration: 3_600_000 };
  add(original, `${THRONES}:0:1`, 1200000, series);
  add(original, `${THRONES}:2:3`, 223000, series);
  add(original, `${THRONES}:2:3`, 3000, series);
  add(original, `${THRONES}:2:4`, 66000, { ...series, undoneAt: 1 });
  add(original, 'tmdb:10:1:1', 16000, series);
  add(original, 'tmdb:10:1:2', 17000, series);
  add(original, 'kitsu:7:4', 18000, series);
  add(original, 'some-addon:show:2:3', 19000, series);
  const { url } = await authorize(owner, original);
  const list = await metas(url, 'series');
  assert.deepEqual(list.map(m => m.id), ['some-addon:show:2:3', 'kitsu:7', 'tmdb:10', THRONES]);
  assert.equal(list[3].name, 'Game of Thrones · T2E3 · 3:43 / 1:00:00');
  assert.match(list[2].name, /T1E2/);
  assert.match(list[1].name, /Ep\. 4/);
  assert.deepEqual(metadataRequests, [`https://v3-cinemeta.strem.io/meta/series/${THRONES}.json`]);

  const skipped = await fetch(`${url}/catalog/series/history-series/skip=1.json`).then(res => res.json());
  assert.deepEqual(skipped.metas.map(m => m.id), ['kitsu:7', 'tmdb:10', THRONES]);
  assert.equal((await fetch(`${url}/catalog/series/history-series/skip=0&skip=1.json`)).status, 400);
});

test('the catalog remains usable when metadata is unavailable or a poster is unsafe or missing', async (t) => {
  const { base, original, owner, add, authorize, metas, posterRequests } = await fixture(t);
  for (const id of [missingMeta, unsafePoster, missingPoster]) add(original, id, 4000);
  const { url } = await authorize(owner, original);
  const list = await metas(url);
  assert.match(list.find(m => m.id === missingMeta).name, /^tt0000000 · 0:04/);
  assert.match(list.find(m => m.id === unsafePoster).name, /^Obra sem capa/);
  const covers = [];
  for (const item of list) {
    const cover = await fetch(`${base}${new URL(item.poster).pathname}`);
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get('content-type'), 'image/jpeg');
    covers.push(Buffer.from(await cover.arrayBuffer()));
  }
  assert.deepEqual(posterRequests, [imdbPoster(missingPoster)], 'only the trusted upstream URL was requested');
  assert.deepEqual(covers[0], covers[1]);
  assert.deepEqual(covers[0], covers[2]);
});

test('catalog links require explicit authorization, use separate secrets, and support rotation and revocation', async (t) => {
  const { base, db, original, owner, add, authorize } = await fixture(t);
  add(original, MATRIX, 21000);
  assert.equal((await new Browser(base).request(PAGE)).location, '/signin');
  assert.equal((await owner.post(`${PAGE}/authorize`, { profileId: original.id })).status, 400);
  assert.equal((await owner.request(`${PAGE}/authorize`, { method: 'POST', form: { profileId: original.id, consent: 'yes' } })).status, 403);
  const foreign = await fetch(`${base}${PAGE}/authorize`, {
    method: 'POST',
    headers: { cookie: owner.cookie, origin: 'https://foreign.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ profileId: original.id, consent: 'yes', _csrf: await owner.csrf() }),
  });
  assert.equal(foreign.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) FROM mp_history_catalog_grants').pluck().get(), 0);
  const dashboard = await owner.request(PAGE);
  assert.match(dashboard.text, /sincroniza os add-ons instalados pela conta/);
  assert.match(dashboard.text, /Nenhum link ativo/);

  const tracking = await owner.post('/devices/tracking/new', { consent: 'yes' });
  const trackingToken = tracking.text.match(/\/devices\/tracking\/addon\/([A-Za-z0-9_-]{43})\/manifest\.json/)[1];
  for (const token of [trackingToken, 'x'.repeat(43)]) {
    assert.equal((await fetch(`${base}${PAGE}/addon/${token}/manifest.json`)).status, 404);
  }
  const link = await authorize(owner, original);
  const manifest = await fetch(`${link.url}/manifest.json`).then(res => res.json());
  assert.equal(db.prepare('SELECT token_hash FROM mp_history_catalog_grants').pluck().get(), sha(link.token));
  assert.doesNotMatch((await owner.request(PAGE)).text, new RegExp(link.token));
  assert.equal((await fetch(`${base}/devices/tracking/addon/${link.token}/manifest.json`)).status, 404);

  const replacement = await authorize(owner, original);
  assert.notEqual(link.token, replacement.token);
  assert.equal((await fetch(`${replacement.url}/manifest.json`).then(res => res.json())).id, manifest.id);
  assert.equal((await fetch(catalogPath(link.url))).status, 404);
  assert.equal((await owner.post(`${PAGE}/revoke`, { profileId: original.id })).location, PAGE);
  for (const path of ['/manifest.json', '/catalog/movie/history-movies.json', `/poster/movie/${MATRIX}.jpg`]) {
    assert.equal((await fetch(replacement.url + path)).status, 404);
  }
});

test('an account cannot authorize or revoke another profile or read outside its catalog grant', async (t) => {
  const { base, accounts, service, fake, original, owner, add, authorize, metas } = await fixture(t);
  add(original, MATRIX, 213000);
  const ownerLink = await authorize(owner, original);
  const visitor = new Browser(base);
  const firstUser = fake.user;
  fake.user = { _id: 'other-user', email: 'other@example.com' };
  try {
    const login = await visitor.request('/signin', { method: 'POST', form: { email: fake.user.email, password: fake.password } });
    assert.equal(login.location, '/configure');
  } finally {
    fake.user = firstUser;
  }
  const other = accounts.forAccount(2).repo.listProfiles()[0];
  add(other, kidsOnlyMovie, 453000);
  assert.equal((await visitor.post(`${PAGE}/authorize`, { profileId: original.id, consent: 'yes' })).status, 404);
  assert.equal((await visitor.post(`${PAGE}/revoke`, { profileId: original.id })).status, 404);

  const visitorLink = await authorize(visitor, other);
  assert.deepEqual((await metas(visitorLink.url)).map(m => m.id), [kidsOnlyMovie]);
  assert.deepEqual((await metas(ownerLink.url)).map(m => m.id), [MATRIX]);
  assert.equal((await fetch(`${visitorLink.url}/poster/movie/${MATRIX}.jpg`)).status, 404);
  const override = await fetch(`${catalogPath(visitorLink.url)}?profileId=${original.id}`).then(res => res.json());
  assert.deepEqual(override.metas.map(m => m.id), [kidsOnlyMovie]);

  await service.setPasscode(original.id, { code: '1234' });
  assert.equal((await fetch(`${ownerLink.url}/manifest.json`)).status, 404);
  assert.equal((await owner.post(`${PAGE}/authorize`, { profileId: original.id, consent: 'yes' })).status, 404);
  assert.equal((await owner.post(`${PAGE}/revoke`, { profileId: original.id })).status, 303);
});

const DYNAMIC = '/devices/dynamic-catalog';
const UNIFIED = '/devices/unified-catalog';
const NETWORK_A = '1.1.1.1';
const NETWORK_B = '8.8.8.8';
const PROXY = '9.9.9.9';

function networkRequest(url, options) {
  if (!options.headers.host) return fetch(url, options);
  // Exercise the Host seen by Express when a proxy sends the public hostname.
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, options, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
    req.end(options.body?.toString());
  });
}

function requestFrom(url, ip, extraHeaders = {}) {
  return networkRequest(url, { headers: { ...(ip && { 'x-forwarded-for': ip }), ...extraHeaders } });
}

async function postFrom(browser, path, ip, fields, extraHeaders = {}) {
  const response = await networkRequest(browser.base + path, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: browser.cookie, ...(ip && { 'x-forwarded-for': ip }),
      'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams({ _csrf: await browser.csrf(), ...fields }),
  });
  return { status: response.status, location: response.headers.get('location'), headers: response.headers, text: await response.text() };
}

async function bind(browser, ip) {
  assert.equal((await postFrom(browser, '/devices/bridge/enable', ip, { consent: 'yes' })).location, '/devices/bridge');
}

async function allowDevice(browser, ip, page = DYNAMIC) {
  assert.equal((await postFrom(browser, `${page}/authorize-device`, ip, { consent: 'yes' })).location, page);
}

async function allowProfile(browser, profile, page = DYNAMIC) {
  assert.equal((await browser.post(`${page}/authorize-profile`, { profileId: profile.id, consent: 'yes' })).location, page);
}

async function dynamicLink(browser, page = DYNAMIC) {
  const issued = await browser.post(`${page}/create-link`, { consent: 'yes' });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const manifest = issued.text.match(/(\/devices\/[a-z-]+\/addon\/[a-zA-Z0-9_-]{43})\/manifest\.json/)[1];
  assert.ok(manifest.startsWith(`${page}/addon/`));
  return `${browser.base}${manifest}`;
}

const dynamicPath = (url, type = 'movie') => `${url}/catalog/${type}/my-profile-${type === 'movie' ? 'movies' : 'series'}.json`;

async function dynamicMovies(url, ip) {
  const response = await requestFrom(dynamicPath(url), ip);
  assert.equal(response.status, 200);
  return (await response.json()).metas;
}

async function dynamicFixture(t, options = {}) {
  // Simulate a reverse proxy trusted by address, not a trust-all deployment.
  const ctx = await fixture(t, { trustProxy: 'loopback', ...options });
  const otherDevice = new Browser(ctx.base);
  assert.equal((await otherDevice.signIn()).location, '/configure');
  await ctx.pair(ctx.owner, ctx.original, 'Sala');
  await ctx.pair(otherDevice, ctx.kids, 'Quarto');
  await bind(ctx.owner, NETWORK_A);
  await bind(otherDevice, NETWORK_B);
  return { ...ctx, otherDevice };
}

test('one dynamic link serves two separately authorized profiles on distinct networks without HTTP cache reuse', async (t) => {
  const { base, db, fake, owner, otherDevice, original, kids, add } = await dynamicFixture(t);
  add(original, MATRIX, 193000);
  add(kids, MATRIX, 12000);
  add(kids, kidsOnlyMovie, 66000);
  add(original, `${THRONES}:1:1`, 300000, { type: 'series' });
  add(original, `${THRONES}:2:3`, 4000, { type: 'series' });
  const historyBefore = db.prepare('SELECT * FROM mp_native_history_events ORDER BY source_event_id').all();
  const stremioCalls = fake.calls.length;

  assert.equal((await new Browser(base).request(DYNAMIC)).location, '/signin');
  assert.equal((await owner.post(`${DYNAMIC}/create-link`)).status, 400);
  const url = await dynamicLink(owner);
  const install = await requestFrom(`${url}/manifest.json`, PROXY).then(r => r.json());
  assert.equal(install.name, 'OpenProfiles — Meu perfil');
  assert.deepEqual(install.resources, ['catalog']);
  assert.deepEqual(install.catalogs.map(c => c.name), ['Meu perfil — Filmes', 'Meu perfil — Séries']);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  await allowProfile(owner, original);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  assert.equal((await postFrom(owner, `${DYNAMIC}/authorize-device`, NETWORK_B, { consent: 'yes' })).status, 409);
  assert.equal((await postFrom(owner, `${DYNAMIC}/authorize-device`, NETWORK_A, {})).status, 400);
  await allowDevice(owner, NETWORK_A);

  const a = await requestFrom(dynamicPath(url), NETWORK_A);
  const aMovies = (await a.json()).metas;
  assert.deepEqual(aMovies.map(m => m.id), [MATRIX]);
  assert.equal(aMovies[0].name, 'The Matrix · 3:13 / 2:00:00');
  assert.deepEqual(await dynamicMovies(url, NETWORK_B), []);
  await allowProfile(owner, kids);
  await allowDevice(otherDevice, NETWORK_B);

  const b = await requestFrom(dynamicPath(url), NETWORK_B, { 'if-none-match': '*' });
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(b.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(b.headers.get('vary'), '*');
  assert.equal(b.headers.get('etag'), null);
  const bMovies = (await b.json()).metas;
  assert.deepEqual(bMovies.map(m => m.id), [kidsOnlyMovie, MATRIX]);
  assert.equal(bMovies[1].name, 'The Matrix · 0:12 / 2:00:00');
  assert.notEqual(aMovies[0].poster, bMovies[1].poster);
  const posterA = base + new URL(aMovies[0].poster).pathname;
  assert.equal((await requestFrom(posterA, NETWORK_B)).status, 404);
  const cover = await requestFrom(posterA, NETWORK_A, { 'if-none-match': '*' });
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  assert.equal(cover.headers.get('etag'), null);
  await cover.arrayBuffer();

  const aSeries = await requestFrom(dynamicPath(url, 'series'), NETWORK_A).then(r => r.json());
  assert.deepEqual(aSeries.metas.map(m => m.id), [THRONES]);
  assert.match(aSeries.metas[0].name, /Game of Thrones · T2E3/);
  assert.deepEqual(await requestFrom(dynamicPath(url, 'series'), NETWORK_B).then(r => r.json()), { metas: [] });
  assert.equal((await requestFrom(`${url}/stream/movie/${MATRIX}.json`, NETWORK_A)).status, 404);
  assert.deepEqual(db.prepare('SELECT * FROM mp_native_history_events ORDER BY source_event_id').all(), historyBefore);
  assert.equal(fake.calls.length, stremioCalls);
});

test('the dynamic catalog is empty with ambiguous, expired, missing or mismatched network associations', async (t) => {
  const { db, config, owner, otherDevice, original, add } = await dynamicFixture(t);
  add(original, MATRIX, 193000);
  await allowProfile(owner, original);
  await allowDevice(owner, NETWORK_A);
  const url = await dynamicLink(owner);
  assert.equal((await dynamicMovies(url, NETWORK_A)).length, 1);
  assert.deepEqual(await dynamicMovies(url), []);
  assert.deepEqual(await dynamicMovies(url, PROXY), []);
  const legacyHint = await requestFrom(dynamicPath(url), undefined, {
    host: new URL(config.publicUrl).host,
    'x-forwarded-host': new URL(config.publicUrl).host,
    'x-forwarded-proto': 'https',
    'x-real-ip': NETWORK_A,
  });
  assert.deepEqual(await legacyHint.json(), { metas: [] });

  // A second binding makes the IP ambiguous even without device consent.
  await bind(otherDevice, NETWORK_A);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  assert.equal((await postFrom(otherDevice, `${DYNAMIC}/authorize-device`, NETWORK_A, { consent: 'yes' })).status, 409);
  await bind(otherDevice, NETWORK_B);
  assert.equal((await dynamicMovies(url, NETWORK_A)).length, 1);

  db.prepare('UPDATE mp_bridge_bindings SET expires_at=0 WHERE device_id=(SELECT id FROM mp_devices WHERE label=?)').run('Sala');
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  await bind(owner, NETWORK_A);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), [], 'a renewed binding requires fresh device consent');
  await allowDevice(owner, NETWORK_A);
  assert.equal((await dynamicMovies(url, NETWORK_A)).length, 1);

  db.prepare('UPDATE mp_devices SET expires_at=0 WHERE label=?').run('Sala');
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
});

test('dynamic reads follow a profile change and respect profile, device and link revocations while v0.7 stays available', async (t) => {
  const { base, service, owner, original, kids, add, authorize, metas } = await dynamicFixture(t);
  add(original, MATRIX, 18000);
  add(kids, kidsOnlyMovie, 84000);
  const fixed = await authorize(owner, original);
  const url = await dynamicLink(owner);
  assert.equal((await requestFrom(`${fixed.url.replace(PAGE, DYNAMIC)}/manifest.json`, NETWORK_A)).status, 404);
  await allowProfile(owner, original);
  await allowDevice(owner, NETWORK_A);

  const originalPoster = (await dynamicMovies(url, NETWORK_A))[0].poster;
  assert.equal((await owner.post('/devices/select-profile', { profileId: kids.id })).location, '/configure');
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  await allowProfile(owner, kids);
  assert.deepEqual((await dynamicMovies(url, NETWORK_A)).map(m => m.id), [kidsOnlyMovie]);
  assert.equal((await requestFrom(base + new URL(originalPoster).pathname, NETWORK_A)).status, 404);
  assert.equal((await owner.post(`${DYNAMIC}/revoke-profile`, { profileId: kids.id })).location, DYNAMIC);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);

  await allowProfile(owner, kids);
  assert.equal((await owner.post(`${DYNAMIC}/revoke-device`)).location, DYNAMIC);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  await allowDevice(owner, NETWORK_A);
  const replacement = await dynamicLink(owner);
  assert.notEqual(replacement, url);
  assert.equal((await requestFrom(dynamicPath(url), NETWORK_A)).status, 404);
  assert.equal((await dynamicMovies(replacement, NETWORK_A)).length, 1);
  await service.setPasscode(kids.id, { code: '1234' });
  assert.deepEqual(await dynamicMovies(replacement, NETWORK_A), []);
  assert.equal((await owner.post(`${DYNAMIC}/revoke-link`)).location, DYNAMIC);
  assert.equal((await requestFrom(dynamicPath(replacement), NETWORK_A)).status, 404);
  assert.deepEqual((await metas(fixed.url)).map(m => m.id), [MATRIX]);
});

test('the dynamic catalog ignores forwarded source under trust-all proxy settings', async (t) => {
  const { owner, original, add } = await dynamicFixture(t, { trustProxy: true });
  add(original, MATRIX, 193000);
  await allowProfile(owner, original);
  const ownerLink = await dynamicLink(owner);
  assert.equal((await postFrom(owner, `${DYNAMIC}/authorize-device`, NETWORK_A, { consent: 'yes' })).status, 409);
  assert.deepEqual(await dynamicMovies(ownerLink, NETWORK_A), []);
});

test('accounts on the same network can only authorize and read their own dynamic history', async (t) => {
  const { base, accounts, fake, owner, original, add, pair } = await dynamicFixture(t);
  add(original, MATRIX, 193000);
  await allowProfile(owner, original);
  await allowDevice(owner, NETWORK_A);
  const ownerLink = await dynamicLink(owner);
  const visitor = new Browser(base);
  const firstUser = fake.user;
  fake.user = { _id: 'other-user', email: 'other@example.com' };
  try {
    const login = await visitor.request('/signin', { method: 'POST', form: { email: fake.user.email, password: fake.password } });
    assert.equal(login.location, '/configure');
  } finally {
    fake.user = firstUser;
  }
  assert.equal((await visitor.post(`${DYNAMIC}/authorize-profile`, { profileId: original.id, consent: 'yes' })).status, 404);
  assert.equal((await visitor.post(`${DYNAMIC}/revoke-profile`, { profileId: original.id })).status, 404);
  const visitorLink = await dynamicLink(visitor);
  assert.deepEqual(await dynamicMovies(visitorLink, NETWORK_A), []);

  const other = accounts.forAccount(2).repo.listProfiles()[0];
  await pair(visitor, other, 'Outro lar');
  await bind(visitor, NETWORK_A);
  add(other, kidsOnlyMovie, 43000);
  await allowProfile(visitor, other);
  await allowDevice(visitor, NETWORK_A);
  assert.deepEqual((await dynamicMovies(ownerLink, NETWORK_A)).map(m => m.id), [MATRIX]);
  assert.deepEqual((await dynamicMovies(visitorLink, NETWORK_A)).map(m => m.id), [kidsOnlyMovie]);
});

test('a profile change while artwork is loading discards the previous catalog response', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { owner, original, kids, add } = await dynamicFixture(t, {
    async onMetadata() {
      started.resolve();
      await release.promise;
    },
  });
  add(original, MATRIX, 193000);
  await allowProfile(owner, original);
  await allowProfile(owner, kids);
  await allowDevice(owner, NETWORK_A);
  const url = await dynamicLink(owner);
  const oldRequest = dynamicMovies(url, NETWORK_A);
  try {
    await Promise.race([started.promise, oldRequest.then(() => { throw new Error('Catalog returned before fetching metadata'); })]);
    assert.equal((await owner.post('/devices/select-profile', { profileId: kids.id })).location, '/configure');
  } finally {
    release.resolve();
  }
  assert.deepEqual(await oldRequest, []);
});

async function manifestAt(url) {
  const response = await fetch(url + '/manifest.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  return response.json();
}

const fixedPath = (url, { type, id }) => [url, 'catalog', type, id].join('/') + '.json';
const fixedCatalog = (manifest, profile, type = 'movie') => manifest.catalogs.find(c =>
  c.type === type && c.name === 'OpenProfiles — ' + profile.name + (type === 'movie' ? ' — Filmes' : ' — Séries'));

async function catalogItems(path, ip, extraHeaders) {
  const response = await requestFrom(path, ip, extraHeaders);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('vary'), '*');
  assert.equal(response.headers.get('etag'), null);
  return (await response.json()).metas;
}

test('the unified manifest keeps fixed consent separate and resolves two paired browsers on distinct networks', async (t) => {
  const { base, db, fake, owner, otherDevice, original, kids, add } = await dynamicFixture(t);
  add(original, MATRIX, 193000);
  add(original, THRONES + ':2:1', 12000, { type: 'series' });
  add(original, THRONES + ':2:3', 43000, { type: 'series' });
  add(kids, kidsOnlyMovie, 84000);
  const stremioCalls = fake.calls.length;
  const anonymous = new Browser(base);
  assert.equal((await anonymous.request(UNIFIED)).location, '/signin');
  const settingsPage = await owner.request(UNIFIED);
  assert.match(settingsPage.text, /Usar neste aparelho/);
  assert.match(settingsPage.text, /outros aparelhos da mesma conta Stremio/);
  assert.equal((await owner.request(UNIFIED + '/authorize-fixed', { method: 'POST', form: { profileId: original.id, consent: 'yes' } })).status, 403);
  assert.equal((await owner.post(UNIFIED + '/authorize-fixed', { profileId: original.id })).status, 400);
  assert.equal((await owner.post(UNIFIED + '/authorize-fixed', { profileId: '1e0', consent: 'yes' })).status, 400);
  const url = await dynamicLink(owner, UNIFIED);
  const initial = await manifestAt(url);
  assert.equal(initial.name, 'OpenProfiles MultiDevice');
  assert.equal(initial.version, '0.9.1');
  assert.deepEqual(initial.resources, ['catalog']);
  assert.deepEqual(initial.catalogs.map(c => c.name), ['Meu perfil — Filmes', 'Meu perfil — Séries']);

  await allowProfile(owner, original, UNIFIED);
  await allowDevice(owner, NETWORK_A, UNIFIED);
  await allowDevice(otherDevice, NETWORK_B, UNIFIED);
  assert.equal((await owner.post(UNIFIED + '/authorize-fixed', { profileId: kids.id, consent: 'yes' })).location, UNIFIED);
  const authorized = await manifestAt(url);
  assert.equal(authorized.id, initial.id);
  assert.equal(fixedCatalog(authorized, original), undefined);
  const kidsRow = fixedCatalog(authorized, kids);
  assert.deepEqual((await catalogItems(fixedPath(url, kidsRow))).map(m => m.id), [kidsOnlyMovie]);
  assert.deepEqual(await dynamicMovies(url, NETWORK_B), [], 'fixed consent gives no automatic permission');
  assert.deepEqual(await dynamicMovies(url), [], 'missing identification never falls back');
  assert.deepEqual(await dynamicMovies(url, PROXY), []);

  await allowProfile(owner, kids, UNIFIED);
  const moviesPath = dynamicPath(url);
  const [fromA, fromB] = await Promise.all([
    catalogItems(moviesPath, NETWORK_A, { 'if-none-match': '*' }),
    catalogItems(moviesPath, NETWORK_B),
  ]);
  assert.deepEqual(fromA.map(m => m.id), [MATRIX]);
  assert.deepEqual(fromB.map(m => m.id), [kidsOnlyMovie]);
  assert.match(fromA[0].name, /The Matrix · 3:13/);
  assert.equal((await requestFrom(base + new URL(fromA[0].poster).pathname, NETWORK_B)).status, 404);
  assert.equal((await requestFrom(base + new URL(fromA[0].poster).pathname, NETWORK_A)).status, 200);
  const series = await catalogItems(dynamicPath(url, 'series'), NETWORK_A);
  assert.deepEqual(series.map(m => m.id), [THRONES]);
  assert.match(series[0].name, /Game of Thrones · T2E3/);
  assert.equal((await fetch(url + '/stream/movie/' + MATRIX + '.json')).status, 404);
  assert.equal((await owner.post(UNIFIED + '/authorize-fixed', { profileId: original.id, consent: 'yes' })).location, UNIFIED);
  const bothFixed = await manifestAt(url);
  const fixedSeries = await catalogItems(fixedPath(url, fixedCatalog(bothFixed, original, 'series')), NETWORK_B);
  assert.deepEqual(fixedSeries.map(m => m.id), [THRONES]);
  assert.equal(fixedSeries[0].name, series[0].name);
  assert.deepEqual((await catalogItems(fixedPath(url, fixedCatalog(bothFixed, original)), NETWORK_B)).map(m => m.id), [MATRIX]);
  assert.equal(fixedCatalog(bothFixed, kids).id, kidsRow.id);

  assert.equal((await owner.post(UNIFIED + '/select-profile', { profileId: kids.id })).location, UNIFIED);
  assert.deepEqual((await dynamicMovies(url, NETWORK_A)).map(m => m.id), [kidsOnlyMovie]);
  assert.equal((await owner.post(UNIFIED + '/select-profile', { profileId: original.id })).location, UNIFIED);
  assert.deepEqual((await dynamicMovies(url, NETWORK_A)).map(m => m.id), [MATRIX]);

  assert.equal((await postFrom(otherDevice, UNIFIED + '/bind-device', NETWORK_A, {})).status, 400);
  assert.equal((await postFrom(otherDevice, UNIFIED + '/bind-device', NETWORK_A, { consent: 'yes' })).location, UNIFIED);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  assert.equal((await postFrom(otherDevice, UNIFIED + '/authorize-device', NETWORK_A, { consent: 'yes' })).status, 409);
  assert.deepEqual((await catalogItems(fixedPath(url, kidsRow), NETWORK_A)).map(m => m.id), [kidsOnlyMovie]);
  db.prepare('UPDATE mp_bridge_bindings SET expires_at=0 WHERE device_id=(SELECT id FROM mp_devices WHERE label=?)').run('Quarto');
  assert.deepEqual((await dynamicMovies(url, NETWORK_A)).map(m => m.id), [MATRIX]);
  db.prepare('UPDATE mp_bridge_bindings SET expires_at=0 WHERE device_id=(SELECT id FROM mp_devices WHERE label=?)').run('Sala');
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  assert.equal(fake.calls.length, stremioCalls);
});

test('unified revocation invalidates old fixed descriptors and covers independently of automatic consent', async (t) => {
  const { base, service, owner, original, add } = await dynamicFixture(t);
  add(original, MATRIX, 193000);
  await allowProfile(owner, original, UNIFIED);
  await allowDevice(owner, NETWORK_A, UNIFIED);
  await owner.post(UNIFIED + '/authorize-fixed', { profileId: original.id, consent: 'yes' });
  const url = await dynamicLink(owner, UNIFIED);
  const manifest = await manifestAt(url);
  const row = fixedCatalog(manifest, original);
  const path = fixedPath(url, row);
  const poster = base + new URL((await catalogItems(path))[0].poster).pathname;
  assert.equal((await fetch(poster, { headers: { 'if-none-match': '*' } })).status, 200);
  assert.equal((await owner.post(UNIFIED + '/revoke-fixed', { profileId: original.id })).location, UNIFIED);
  assert.equal(fixedCatalog(await manifestAt(url), original), undefined);
  assert.deepEqual(await catalogItems(path), []);
  assert.equal((await fetch(poster)).status, 404);
  assert.deepEqual((await dynamicMovies(url, NETWORK_A)).map(m => m.id), [MATRIX]);

  await owner.post(UNIFIED + '/authorize-fixed', { profileId: original.id, consent: 'yes' });
  const newRow = fixedCatalog(await manifestAt(url), original);
  assert.notEqual(newRow.id, row.id);
  assert.deepEqual(await catalogItems(path), []);
  assert.equal((await owner.post(UNIFIED + '/revoke-profile', { profileId: original.id })).location, UNIFIED);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  assert.deepEqual((await catalogItems(fixedPath(url, newRow))).map(m => m.id), [MATRIX]);
  await allowProfile(owner, original, UNIFIED);
  assert.equal((await owner.post(UNIFIED + '/revoke-device')).location, UNIFIED);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  await allowDevice(owner, NETWORK_A, UNIFIED);

  const replacement = await dynamicLink(owner, UNIFIED);
  assert.notEqual(replacement, url);
  assert.equal((await manifestAt(replacement)).id, manifest.id);
  assert.equal((await fetch(url + '/manifest.json')).status, 404);
  assert.equal((await fetch(poster)).status, 404);
  assert.deepEqual((await dynamicMovies(replacement, NETWORK_A)).map(m => m.id), [MATRIX]);
  assert.deepEqual((await catalogItems(fixedPath(replacement, newRow))).map(m => m.id), [MATRIX]);

  await service.setPasscode(original.id, { code: '1234' });
  assert.equal(fixedCatalog(await manifestAt(replacement), original), undefined);
  assert.deepEqual(await catalogItems(fixedPath(replacement, newRow)), []);
  assert.deepEqual(await dynamicMovies(replacement, NETWORK_A), []);
  assert.equal((await owner.post(UNIFIED + '/revoke-link')).location, UNIFIED);
  assert.equal((await fetch(replacement + '/manifest.json')).status, 404);
  assert.equal((await fetch(fixedPath(replacement, newRow))).status, 404);
});

test('tokens for a second account on the same IP cannot read or authorize another account’s unified catalog', async (t) => {
  const { base, accounts, fake, owner, original, add, pair } = await dynamicFixture(t);
  add(original, MATRIX, 193000);
  await owner.post(UNIFIED + '/authorize-fixed', { profileId: original.id, consent: 'yes' });
  await allowProfile(owner, original, UNIFIED);
  await allowDevice(owner, NETWORK_A, UNIFIED);
  const ownerLink = await dynamicLink(owner, UNIFIED);
  const ownerRow = fixedCatalog(await manifestAt(ownerLink), original);
  const visitor = new Browser(base);
  const firstUser = fake.user;
  fake.user = { _id: 'other-user', email: 'other@example.com' };
  try {
    const login = await visitor.request('/signin', { method: 'POST', form: { email: fake.user.email, password: fake.password } });
    assert.equal(login.location, '/configure');
  } finally {
    fake.user = firstUser;
  }
  const other = accounts.forAccount(2).repo.listProfiles()[0];
  await pair(visitor, other, 'Outro lar');
  await bind(visitor, NETWORK_A);
  add(other, kidsOnlyMovie, 84000);
  assert.equal((await visitor.post(UNIFIED + '/authorize-fixed', { profileId: original.id, consent: 'yes' })).status, 404);
  assert.equal((await visitor.post(UNIFIED + '/revoke-fixed', { profileId: original.id })).status, 404);
  await visitor.post(UNIFIED + '/authorize-fixed', { profileId: other.id, consent: 'yes' });
  await allowProfile(visitor, other, UNIFIED);
  await allowDevice(visitor, NETWORK_A, UNIFIED);
  const visitorLink = await dynamicLink(visitor, UNIFIED);
  const visitorManifest = await manifestAt(visitorLink);
  const visitorRow = fixedCatalog(visitorManifest, other);
  assert.notEqual(visitorManifest.id, (await manifestAt(ownerLink)).id);
  assert.deepEqual(await catalogItems(fixedPath(visitorLink, ownerRow), NETWORK_A), []);
  assert.deepEqual(await catalogItems(fixedPath(ownerLink, visitorRow), NETWORK_A), []);
  assert.deepEqual((await catalogItems(fixedPath(visitorLink, visitorRow), NETWORK_A)).map(m => m.id), [kidsOnlyMovie]);
  assert.deepEqual((await dynamicMovies(visitorLink, NETWORK_A)).map(m => m.id), [kidsOnlyMovie]);
  assert.deepEqual((await dynamicMovies(ownerLink, NETWORK_A)).map(m => m.id), [MATRIX]);
  assert.deepEqual((await catalogItems(fixedPath(ownerLink, ownerRow), NETWORK_A)).map(m => m.id), [MATRIX]);
});

test('opening a v0.8 database preserves legacy rows and links without copying their consent to v0.9', async (t) => {
  const ctx = await dynamicFixture(t);
  const { db, config, owner, original, historyCatalogUpstream, add, authorize } = ctx;
  add(original, MATRIX, 193000);
  db.prepare(`INSERT INTO mp_progress
    (account_id,profile_id,video_id,media_id,type,title,current_ms,duration_ms,action,device_id,updated_at)
    SELECT account_id,profile_id,?,?,'movie','The Matrix',193000,7200000,'pause',id,created_at
    FROM mp_devices WHERE label='Sala'`).run(MATRIX, MATRIX);
  const oldFixed = await authorize(owner, original);
  await allowProfile(owner, original);
  await allowDevice(owner, NETWORK_A);
  const oldDynamic = await dynamicLink(owner);
  const legacyTables = [
    'accounts', 'profiles', 'mp_devices', 'mp_progress', 'mp_native_history_events', 'mp_bridge_bindings',
    'mp_history_catalog_grants', 'mp_dynamic_catalog_installs', 'mp_dynamic_catalog_profiles', 'mp_dynamic_catalog_devices',
  ];
  const unifiedTables = ['installs', 'profiles', 'devices', 'fixed_profiles'].map(suffix => 'mp_unified_catalog_' + suffix);
  const snapshot = database => legacyTables.map(table => database.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  const before = snapshot(db);
  const directory = await mkdtemp(join(tmpdir(), 'openprofiles-v08-'));
  let restored;
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    restored?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await db.backup(join(directory, 'openprofiles.db'));
  // Build a pre-upgrade fixture on the temporary copy by removing only the
  // new, empty tables. Legacy state was written via the original endpoints.
  const saved = openDatabase(directory);
  try {
    for (const table of unifiedTables) {
      assert.deepEqual(saved.prepare('SELECT * FROM ' + table).all(), []);
      saved.exec('DROP TABLE ' + table);
    }
  } finally {
    saved.close();
  }

  restored = openDatabase(directory);
  const settings = new Settings({ db: restored, env: { ACCESS: 'open' } });
  const accounts = new AccountsService({
    db: restored, cipher: ctx.cipher, stremio: ctx.stremio, access: () => settings.access(), fetchManifest: ctx.web.fetchManifest,
  });
  const app = createApp({ config, db: restored, accounts, settings, log: silentLogger, historyCatalogUpstream });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  assert.deepEqual(snapshot(restored), before);
  for (const table of unifiedTables) assert.deepEqual(restored.prepare('SELECT * FROM ' + table).all(), []);
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = new Browser(base);
  browser.jar = new Map(owner.jar);
  const legacyFixed = base + new URL(oldFixed.url).pathname;
  const legacyDynamic = base + new URL(oldDynamic).pathname;
  const url = await dynamicLink(browser, UNIFIED);
  assert.deepEqual((await manifestAt(url)).catalogs.map(c => c.name), ['Meu perfil — Filmes', 'Meu perfil — Séries']);
  assert.deepEqual(await dynamicMovies(url, NETWORK_A), []);
  assert.equal((await postFrom(browser, UNIFIED + '/bind-device', NETWORK_A, { consent: 'yes' })).location, UNIFIED);
  assert.deepEqual(snapshot(restored), before, 'reusing an active binding preserves the old grant');
  assert.equal((await fetch(legacyFixed + '/manifest.json')).status, 200);
  assert.deepEqual((await ctx.metas(legacyFixed)).map(m => m.id), [MATRIX]);
  assert.deepEqual((await dynamicMovies(legacyDynamic, NETWORK_A)).map(m => m.id), [MATRIX]);
  assert.equal((await browser.post(UNIFIED + '/revoke-link')).location, UNIFIED);
  assert.deepEqual((await ctx.metas(legacyFixed)).map(m => m.id), [MATRIX]);
  assert.deepEqual((await dynamicMovies(legacyDynamic, NETWORK_A)).map(m => m.id), [MATRIX]);
  assert.deepEqual(snapshot(restored), before);
});

test('revoking a fixed grant during metadata loading discards the pending response', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { owner, original, add } = await dynamicFixture(t, {
    async onMetadata() {
      started.resolve();
      await release.promise;
    },
  });
  add(original, MATRIX, 193000);
  await owner.post(UNIFIED + '/authorize-fixed', { profileId: original.id, consent: 'yes' });
  const url = await dynamicLink(owner, UNIFIED);
  const row = fixedCatalog(await manifestAt(url), original);
  const pending = catalogItems(fixedPath(url, row));
  try {
    await Promise.race([started.promise, pending.then(() => { throw new Error('Catalog returned before fetching metadata'); })]);
    assert.equal((await owner.post(UNIFIED + '/revoke-fixed', { profileId: original.id })).location, UNIFIED);
  } finally {
    release.resolve();
  }
  assert.deepEqual(await pending, []);
});

function railwayHeaders(ip) {
  return { host: 'profiles.example.com', 'x-forwarded-host': 'profiles.example.com',
    'x-forwarded-proto': 'https', 'x-railway-edge': 'test-edge', 'x-real-ip': ip };
}

test('unified binding and catalog use the same isolated Railway ingress for two paired devices', async (t) => {
  const { base, db, owner, pair, original, kids, add } = await fixture(t, { catalogRailwayEdgeOnly: true });
  const other = new Browser(base);
  assert.equal((await other.signIn()).status, 303);
  await pair(owner, original, 'Sala');
  await pair(other, kids, 'Quarto');
  add(original, MATRIX, 193000);
  add(kids, kidsOnlyMovie, 85000);
  const ipv6 = '2606:4700:4700::1111';
  const consent = { consent: 'yes' };
  for (const [browser, profile, ip] of [[owner, original, ipv6], [other, kids, NETWORK_B]]) {
    await allowProfile(browser, profile, UNIFIED);
    assert.equal((await postFrom(browser, UNIFIED + '/bind-device', undefined, consent, railwayHeaders(ip))).location, UNIFIED);
    assert.equal((await postFrom(browser, UNIFIED + '/authorize-device', undefined, consent, railwayHeaders(ip))).location, UNIFIED);
  }
  const stored = db.prepare('SELECT * FROM mp_bridge_bindings ORDER BY device_id').all();
  assert.equal((await postFrom(owner, UNIFIED + '/bind-device', undefined, consent, railwayHeaders(ipv6))).status, 303);
  assert.deepEqual(db.prepare('SELECT * FROM mp_bridge_bindings ORDER BY device_id').all(), stored);
  const url = await dynamicLink(owner, UNIFIED);
  const path = dynamicPath(url);
  assert.deepEqual((await catalogItems(path, undefined, railwayHeaders(ipv6))).map(m => m.id), [MATRIX]);
  assert.deepEqual((await catalogItems(path, undefined, railwayHeaders(NETWORK_B))).map(m => m.id), [kidsOnlyMovie]);
  assert.deepEqual(await catalogItems(path, NETWORK_B), []);
  assert.deepEqual(await catalogItems(path, undefined, railwayHeaders('10.2.3.4')), []);
  assert.deepEqual(await catalogItems(path, undefined, railwayHeaders(PROXY)), []);

  assert.equal((await postFrom(other, UNIFIED + '/bind-device', undefined, consent, railwayHeaders(ipv6))).location, UNIFIED);
  assert.deepEqual(await catalogItems(path, undefined, railwayHeaders(ipv6)), [], 'two active bindings make the network ambiguous');
  assert.equal((await postFrom(other, UNIFIED + '/authorize-device', undefined, consent, railwayHeaders(ipv6))).status, 409);
});

test('authenticated network diagnosis separates pairing, profile and IP without including private values', async (t) => {
  const { base, db, owner, pair, original, kids, service, add } = await fixture(t, { trustProxy: 'loopback, uniquelocal' });
  const diagnosis = UNIFIED + '/network-diagnostic';
  const anonymous = new Browser(base);
  assert.equal((await anonymous.request(diagnosis)).location, '/signin');
  assert.equal((await anonymous.request(UNIFIED + '/bind-device', { method: 'POST' })).location, '/signin');
  const noPair = await owner.request(diagnosis);
  assert.equal(noPair.headers.get('cache-control'), 'no-store');
  assert.match(noPair.text, /Navegador pareado nesta conta · Não/);
  assert.match(noPair.text, /Perfil elegível selecionado · Não/);

  await pair(owner, original, 'Sala');
  const privateIp = '10.2.3.4';
  const ipHeaders = railwayHeaders(NETWORK_A);
  const failed = await postFrom(owner, UNIFIED + '/bind-device', privateIp, { consent: 'yes' }, ipHeaders);
  assert.equal(failed.status, 409);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.match(failed.text, /Navegador pareado nesta conta · Sim/);
  assert.match(failed.text, /Perfil elegível selecionado · Sim/);
  assert.match(failed.text, /IP público resolvido por uma origem confiável · Não/);
  for (const value of [privateIp, NETWORK_A, owner.cookie, ...owner.jar.values(), await owner.csrf()]) {
    if (value) assert.ok(!failed.text.includes(value));
  }
  assert.deepEqual(db.prepare('SELECT * FROM mp_bridge_bindings').all(), []);
  const resolved = await requestFrom(base + diagnosis, NETWORK_B, { cookie: owner.cookie }).then(r => r.text());
  assert.match(resolved, /IP público resolvido por uma origem confiável · Sim/);
  assert.ok(!resolved.includes(NETWORK_B));

  await service.setPasscode(original.id, { code: '1234' });
  const unavailable = await requestFrom(base + diagnosis, NETWORK_B, { cookie: owner.cookie }).then(r => r.text());
  assert.match(unavailable, /Navegador pareado nesta conta · Sim/);
  assert.match(unavailable, /Perfil elegível selecionado · Não/);
  assert.match(unavailable, /IP público resolvido por uma origem confiável · Sim/);

  await owner.post(UNIFIED + '/authorize-fixed', { profileId: kids.id, consent: 'yes' });
  add(kids, kidsOnlyMovie, 85000);
  const url = await dynamicLink(owner, UNIFIED);
  assert.deepEqual(await dynamicMovies(url), []);
  const fixed = fixedCatalog(await manifestAt(url), kids);
  assert.deepEqual((await catalogItems(fixedPath(url, fixed))).map(m => m.id), [kidsOnlyMovie]);
});

test('v0.7 serves both URLs advertised by the same legacy manifest without network identification', async (t) => {
  const { db, base, owner, original, add, authorize, service } = await fixture(t);
  const { token, url } = await authorize(owner, original);
  const lookup = db.prepare('SELECT * FROM mp_history_catalog_grants WHERE profile_id=?');
  const grant = lookup.get(original.id);
  const manifestResponse = await fetch(url + '/manifest.json');
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.deepEqual(manifest.catalogs.map(c => c.type), ['movie', 'series']);
  add(original, MATRIX, 193000);
  for (const catalog of manifest.catalogs) {
    const path = fixedPath(url, catalog);
    for (const variant of [path, path.replace(/\.json$/, '/skip=0.json')]) {
      const response = await requestFrom(variant);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).metas.map(m => m.id), catalog.type === 'movie' ? [MATRIX] : []);
    }
    assert.equal((await fetch(path.replace(catalog.id, 'old-catalog-id'))).status, 404);
    assert.equal((await fetch(path.replace(token, 'A'.repeat(43)))).status, 404);
  }
  const status = await owner.request(PAGE);
  assert.match(status.text, /Original · link ativo/);
  assert.ok(!status.text.includes(token));
  assert.deepEqual(lookup.get(original.id), grant);
  assert.equal((await new Browser(base).request(PAGE)).location, '/signin');

  await service.setPasscode(original.id, { code: '1234' });
  assert.match((await owner.request(PAGE)).text, /Original · perfil indisponível/);
  for (const catalog of manifest.catalogs) assert.equal((await fetch(fixedPath(url, catalog))).status, 404);
  assert.deepEqual(lookup.get(original.id), grant);
});
