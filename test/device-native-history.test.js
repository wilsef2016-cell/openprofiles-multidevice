import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { Browser } from './helpers/browser.js';
import { linkedWithKids } from './helpers/setup.js';

const HISTORY = '/devices/native-history';
const TRACKING = '/devices/tracking';
const NETWORK_A = '1.1.1.1';
const NETWORK_B = '8.8.8.8';
const VIDEO = 'tt0133093';

async function fixture(t) {
  const previous = process.env.MULTIDEVICE_MODE;
  process.env.MULTIDEVICE_MODE = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.MULTIDEVICE_MODE;
    else process.env.MULTIDEVICE_MODE = previous;
  });
  const ctx = await linkedWithKids({ access: { mode: 'open' } });
  const { db, accounts, settings, original, kids } = ctx;
  // The local test client represents a trusted reverse proxy and supplies the public address.
  const config = { publicUrl: 'http://localhost', trustProxy: true };
  const server = createApp({ config, db, accounts, settings, log: silentLogger }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(() => { db.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function pair(profileId, label) {
    const browser = new Browser(base);
    assert.equal((await browser.signIn()).status, 303);
    const codePage = await browser.post('/devices/new-pair', { profileId, label });
    assert.equal(codePage.status, 200);
    const code = codePage.text.match(/<h2><code>([A-Z0-9]+)<\/code><\/h2>/)[1];
    assert.equal((await browser.request('/devices/activate', { method: 'POST', form: { code } })).location, '/devices/me');
    return browser;
  }

  const a = await pair(original.id, 'Sala');
  const b = await pair(kids.id, 'Quarto');
  const install = await a.post(`${TRACKING}/new`, { consent: 'yes' });
  assert.equal(install.status, 200);
  const resource = install.text.match(/(\/devices\/tracking\/addon\/[A-Za-z0-9_-]+)\/manifest\.json/)[1];

  async function bind(browser, ip) {
    const res = await fetch(base + '/devices/bridge/enable', {
      method: 'POST', redirect: 'manual',
      headers: { cookie: browser.cookie, 'x-forwarded-for': ip, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'consent=yes',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/devices/bridge');
    await res.text();
  }

  async function track(ip, action, position, videoId = VIDEO) {
    const params = new URLSearchParams({ action, currentTime: position, duration: 120000 });
    const res = await fetch(`${base}${resource}/player/movie/${videoId}/${params}.json`, {
      headers: { 'x-forwarded-for': ip },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
  }

  const outcome = () => db.prepare('SELECT status FROM mp_native_history_outcomes ORDER BY event_id DESC LIMIT 1').pluck().get();
  const ledger = () => db.prepare('SELECT * FROM mp_native_history_events ORDER BY source_event_id').all();
  const enable = async (browser) => assert.equal((await browser.post(`${HISTORY}/enable`, { consent: 'yes' })).location, HISTORY);
  const page = (browser, profile) => browser.request(`${HISTORY}?profileId=${profile.id}`).then(response => response.text);
  const select = async (browser, profile) => assert.equal((await browser.post('/devices/select-profile', { profileId: profile.id })).location, '/configure');
  return { ...ctx, base, a, b, bind, track, outcome, ledger, enable, page, select };
}

test('native history is off by default, keeps simultaneous networks separate, and supports deduplication and undo', async (t) => {
  const { db, repo, fake, a, b, original, kids, bind, track, outcome, ledger, enable, page } = await fixture(t);
  await bind(a, NETWORK_A);
  await bind(b, NETWORK_B);
  assert.match(await page(a, original), /Ativar atribuição experimental/);
  await track(NETWORK_A, 'start', 0);
  assert.equal(outcome(), 'disabled');
  assert.deepEqual(ledger(), []);

  assert.equal((await a.post(`${HISTORY}/enable`)).status, 400);
  assert.equal((await a.request(`${HISTORY}/enable`, { method: 'POST', form: { consent: 'yes' } })).status, 403);
  await enable(a);
  await enable(b);

  // Record a separate, previously confirmed position from the experimental web player.
  const webProgress = { type: 'movie', mediaId: VIDEO, title: 'Matrix', minutes: 1, duration: 2 };
  assert.equal((await a.request('/devices/update', { method: 'POST', form: webProgress })).status, 303);
  const confirmedHistory = (await a.request('/devices/history.json')).text;
  const stremioCalls = fake.calls.length;

  await Promise.all([track(NETWORK_A, 'start', 0), track(NETWORK_B, 'start', 0)]);
  await Promise.all([track(NETWORK_A, 'pause', 30000), track(NETWORK_B, 'pause', 51000)]);
  await track(NETWORK_A, 'pause', 30000);
  assert.equal(outcome(), 'duplicate');
  await Promise.all([track(NETWORK_A, 'stop', 31000), track(NETWORK_B, 'stop', 52000)]);

  assert.deepEqual(ledger().filter(e => e.profile_id === original.id).map(e => e.action), ['start', 'pause', 'stop']);
  assert.deepEqual(ledger().filter(e => e.profile_id === kids.id).map(e => e.action), ['start', 'pause', 'stop']);
  assert.match(await page(a, original), /tt0133093 · 31 s · hipótese por rede/);
  assert.match(await page(b, kids), /tt0133093 · 52 s · hipótese por rede/);

  await track(NETWORK_A, 'start', 1000);
  assert.match(await page(a, original), /tt0133093 · 31 s · hipótese por rede/);
  await track(NETWORK_A, 'stop', 83000);
  assert.match(await page(a, original), /tt0133093 · 83 s · hipótese por rede/);
  const playbackId = ledger().at(-1).playback_id;

  // Diagnostic retention does not erase an assigned history or its undo trail.
  db.prepare('UPDATE mp_tracking_events SET received_at=0').run();
  await a.request(TRACKING);
  assert.equal(db.prepare('SELECT COUNT(*) FROM mp_tracking_events').pluck().get(), 0);
  assert.match(await page(a, original), /tt0133093 · 83 s/);
  assert.equal((await a.post(`${HISTORY}/undo`, { playbackId })).location, `${HISTORY}?profileId=${original.id}`);
  assert.ok(ledger().filter(e => e.playback_id === playbackId).every(e => e.undone_at !== null));
  assert.match(await page(a, original), /tt0133093 · 31 s · hipótese por rede/);
  assert.match(await page(b, kids), /tt0133093 · 52 s · hipótese por rede/);
  await track(NETWORK_A, 'stop', 83000);
  assert.equal(outcome(), 'duplicate');

  assert.equal((await a.request('/devices/history.json')).text, confirmedHistory);
  assert.equal(repo.getState().active_profile_id, original.id);
  assert.equal(fake.calls.length, stremioCalls);
});

test('a shared or expired network binding leaves native events unassigned', async (t) => {
  const { db, a, b, bind, track, outcome, ledger, enable } = await fixture(t);
  await bind(a, NETWORK_A);
  await enable(a);
  await track(NETWORK_A, 'start', 1000);
  assert.equal(outcome(), 'assigned');

  // The second binding blocks attribution even though that device has not opted in.
  await bind(b, NETWORK_A);
  await track(NETWORK_A, 'pause', 34000);
  assert.equal(outcome(), 'ambiguous');
  assert.equal(ledger().length, 1);
  assert.match((await a.request(TRACKING)).text, /Sem atribuição \(rede ambígua\)/);
  await enable(b);
  await track(NETWORK_A, 'start', 0);
  assert.equal(outcome(), 'ambiguous');
  assert.equal(ledger().length, 1);

  await bind(b, NETWORK_B);
  await track(NETWORK_A, 'stop', 35000);
  assert.equal(outcome(), 'no-start');
  await track(NETWORK_A, 'start', 2000);
  assert.equal(outcome(), 'assigned');

  db.prepare('UPDATE mp_bridge_bindings SET expires_at=0').run();
  await track(NETWORK_A, 'pause', 38000);
  assert.equal(outcome(), 'unmatched');
  await track(NETWORK_B, 'start', 0);
  assert.equal(outcome(), 'unmatched');
  assert.equal(ledger().length, 2);
  await bind(a, NETWORK_A);
  await track(NETWORK_A, 'stop', 40000);
  assert.equal(outcome(), 'no-start');
  assert.equal(ledger().length, 2);
});

test('switching profile or opting out closes experimental playback without rewriting either history', async (t) => {
  const { db, a, original, kids, bind, track, outcome, ledger, enable, page, select } = await fixture(t);
  await bind(a, NETWORK_A);
  await enable(a);

  await track(NETWORK_A, 'start', 0);
  await track(NETWORK_A, 'pause', 25000);
  await select(a, kids);
  await track(NETWORK_A, 'stop', 26000);
  assert.equal(outcome(), 'no-start');
  assert.match(await page(a, kids), /Nenhum progresso atribuído/);

  await track(NETWORK_A, 'start', 1000);
  await track(NETWORK_A, 'pause', 12000);
  assert.match(await page(a, kids), /tt0133093 · 12 s/);
  await select(a, original);
  await track(NETWORK_A, 'stop', 27000);
  assert.equal(outcome(), 'no-start');
  assert.match(await page(a, original), /tt0133093 · 25 s/);

  await track(NETWORK_A, 'start', 2000);
  assert.equal(outcome(), 'assigned');
  assert.equal((await a.post(`${HISTORY}/disable`)).location, HISTORY);
  await track(NETWORK_A, 'pause', 85000);
  assert.equal(outcome(), 'disabled');
  assert.ok(db.prepare('SELECT 1 FROM mp_bridge_bindings').get(), 'disabling history preserves the existing bridge');
  assert.match(await page(a, original), /tt0133093 · 25 s/);
  assert.match(await page(a, kids), /tt0133093 · 12 s/);

  await enable(a);
  await track(NETWORK_A, 'stop', 86000);
  assert.equal(outcome(), 'no-start');
  assert.equal(ledger().length, 5);
});

test('native history consent and undo stay within the paired account and respect profile PINs', async (t) => {
  const { base, fake, service, original, a, bind, track, outcome, ledger, enable, page } = await fixture(t);
  await bind(a, NETWORK_A);
  await enable(a);
  await track(NETWORK_A, 'start', 0);
  const playbackId = ledger()[0].playback_id;
  const guest = new Browser(base);
  const firstUser = fake.user;
  fake.user = { _id: 'other-user', email: 'other@example.com' };
  try {
    const signIn = await guest.request('/signin', { method: 'POST', form: { email: fake.user.email, password: fake.password } });
    assert.equal(signIn.location, '/configure');
  } finally {
    fake.user = firstUser;
  }
  guest.jar.set('mp_device', a.jar.get('mp_device'));
  assert.equal((await guest.post(`${HISTORY}/enable`, { consent: 'yes' })).status, 403);
  assert.equal((await guest.post(`${HISTORY}/disable`)).status, 403);
  assert.equal((await guest.post(`${HISTORY}/undo`, { playbackId })).status, 404);
  assert.doesNotMatch(await page(guest, original), /tt0133093/);

  await service.setPasscode(original.id, { code: '1234' });
  await track(NETWORK_A, 'pause', 30000);
  assert.equal(outcome(), 'profile-unavailable');
  assert.equal((await a.post(`${HISTORY}/undo`, { playbackId })).status, 404);
  assert.doesNotMatch(await page(a, original), /tt0133093/);
  assert.equal(ledger().length, 1);
  assert.equal(ledger()[0].undone_at, null);
});
