import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import sharp from 'sharp';
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

async function fixture(t) {
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
  const config = { publicUrl: 'https://profiles.example.com', trustProxy: false };
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
  return { ...ctx, repo, original, kids, config, metadataRequests, posterRequests, owner, base, add, authorize, metas };
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
