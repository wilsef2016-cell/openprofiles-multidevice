import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { CATALOG_TYPE } from '../src/addon/manifest.js';
import { silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { Browser } from './helpers/browser.js';
import { linkedWithKids } from './helpers/setup.js';

async function startMultiDevice(t) {
  const previousMode = process.env.MULTIDEVICE_MODE;
  process.env.MULTIDEVICE_MODE = 'true';
  t.after(() => {
    if (previousMode === undefined) delete process.env.MULTIDEVICE_MODE;
    else process.env.MULTIDEVICE_MODE = previousMode;
  });

  const ctx = await linkedWithKids({ withAddon: true, access: { mode: 'open' } });
  const { db, accounts, settings, service } = ctx;
  const locked = await service.createProfile({ name: 'Locked' });
  await service.setPasscode(locked.id, { code: '1234' });
  const config = { publicUrl: 'http://localhost', trustProxy: false };
  const server = createApp({ config, db, accounts, settings, log: silentLogger }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(() => { db.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, config, base, locked };
}

async function pairCode(browser, profileId, label) {
  const page = await browser.post('/devices/new-pair', { profileId, label });
  assert.equal(page.status, 200);
  return page.text.match(/<h2><code>([A-Z0-9]+)<\/code><\/h2>/)[1];
}

const activate = (browser, code) => browser.request('/devices/activate', { method: 'POST', form: { code } });
async function pair(browser, profileId, label) {
  assert.equal((await browser.signIn()).status, 303);
  const code = await pairCode(browser, profileId, label);
  const response = await activate(browser, code);
  assert.equal(response.location, '/devices/me');
  assert.ok(response.headers.getSetCookie().some((cookie) => /^mp_device=.+; Path=\/;.*HttpOnly.*SameSite=Lax/.test(cookie)));
  return code;
}

const select = (browser, profileId) => browser.post('/devices/select-profile', { profileId });
const history = async (browser) => JSON.parse((await browser.request('/devices/history.json')).text);
const card = (page, id) => page.text.split('</article>').find((fragment) => fragment.includes(`/avatars/profile/${id}.svg`));

test('MultiDevice selects a profile on one paired browser without changing Stremio', async (t) => {
  const { db, repo, fake, service, original, kids, config, base, locked } = await startMultiDevice(t);
  const a = new Browser(base);
  const b = new Browser(base);
  await pair(a, original.id, 'Sala');
  await pair(b, original.id, 'Quarto');
  const token = a.jar.get('mp_device');
  const before = db.prepare('SELECT * FROM mp_devices WHERE label=?').get('Sala');
  const initialPage = await a.request('/configure');
  assert.match(card(initialPage, original.id), /Em uso neste aparelho/);
  assert.match(card(initialPage, kids.id), /Usar neste aparelho/);
  assert.doesNotMatch(card(initialPage, locked.id), /Usar neste aparelho/);
  assert.doesNotMatch((await a.request('/profiles/new')).text, /name="switchNow"/);

  const progress = { type: 'movie', mediaId: 'tt0133093', title: 'Matrix', minutes: 1, duration: 2, profileId: original.id };
  assert.equal((await a.request('/devices/update', { method: 'POST', form: progress })).status, 303);
  const stremioCalls = fake.calls.length;
  assert.equal((await a.request('/devices/select-profile', { method: 'POST', form: { profileId: kids.id } })).status, 403);
  await select(a, locked.id);
  assert.equal((await history(a)).profile, 'Original');

  // An existing path-scoped cookie is still usable on /devices and migrates on selection.
  a.jar.delete('mp_device');
  assert.doesNotMatch(await a.request('/configure').then((page) => page.text), /Em uso neste aparelho/);
  const legacySelection = await fetch(base + '/devices/select-profile', {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: `${a.cookie}; mp_device=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: await a.csrf(), profileId: kids.id }),
  });
  assert.equal(legacySelection.headers.get('location'), '/configure');
  assert.ok(legacySelection.headers.getSetCookie().some((cookie) => cookie.startsWith(`mp_device=${token}; Path=/;`)));
  a.jar.set('mp_device', token);

  const activePage = await a.request('/configure');
  assert.match(card(activePage, kids.id), /Em uso neste aparelho/);
  assert.match(card(await a.request(`/profiles/${kids.id}`), kids.id), /Em uso neste aparelho/);
  assert.match(card(await b.request('/configure'), original.id), /Em uso neste aparelho/);
  assert.deepEqual(db.prepare('SELECT * FROM mp_devices WHERE id=?').get(before.id), { ...before, profile_id: kids.id });
  assert.equal((await a.request('/devices/update', { method: 'POST', form: progress })).status, 409);
  assert.deepEqual(await history(a), { profile: 'Kids', items: [] });
  assert.equal((await history(b)).items[0].title, 'Matrix');

  assert.equal((await a.post(`/profiles/${kids.id}/switch`)).location, '/configure');
  const addonToken = repo.getState().addon_token;
  assert.equal((await a.request(`/${addonToken}/unlock/${locked.id}`)).location, '/configure');
  const unlock = await a.request(`/${addonToken}/unlock/${locked.id}`, { method: 'POST', form: { passcode: '1234' } });
  assert.equal(unlock.location, '/configure');
  await assert.rejects(service.switchTo(kids.id), { code: 'MULTIDEVICE' });
  for (const profile of [kids, locked]) {
    const stream = await a.request(`/${addonToken}/stream/${CATALOG_TYPE}/openprofiles:${profile.id}.json`);
    assert.equal(JSON.parse(stream.text).streams[0].externalUrl, `${config.publicUrl}/configure`);
  }
  assert.equal(fake.calls.length, stremioCalls);

  const isStremioWrite = ({ method }) => ['datastorePut', 'addonCollectionSet'].includes(method);
  const created = await a.post('/profiles', { name: 'Extra', from: 'empty', switchNow: '1' });
  assert.equal(created.location, '/configure');
  assert.ok(repo.listProfiles().some((profile) => profile.name === 'Extra'));
  assert.ok(fake.calls.slice(stremioCalls).every((call) => !isStremioWrite(call)));
  assert.equal(repo.getState().active_profile_id, original.id);

  const beforeRecovery = fake.calls.length;
  const backup = repo.listBackups().find((entry) => entry.kind === 'original');
  const journalId = repo.startJournal({
    kind: 'switch', fromProfileId: original.id, toProfileId: kids.id, rollbackBackupId: backup.id,
  });
  const recoveryPage = await a.request('/configure');
  assert.doesNotMatch(recoveryPage.text, /action="\/recovery\/finish"/);
  assert.match(recoveryPage.text, /action="\/recovery\/rollback"/);
  assert.equal((await a.post('/recovery/finish')).location, '/configure');
  assert.match((await a.request('/configure')).text, /não permite concluir uma troca global/);
  assert.equal(repo.getOpenJournal().id, journalId);
  assert.equal(repo.getState().active_profile_id, original.id);
  assert.equal(fake.calls.length, beforeRecovery);

  await a.request('/devices/unpair', { method: 'POST' });
  await select(a, original.id);
  assert.match((await a.request('/configure')).text, /Pareie este navegador com esta conta/);
  assert.equal((await a.request('/devices/history.json')).status, 401);
});

test('MultiDevice checks pairing ownership, expiry, source and profile permission', async (t) => {
  const { accounts, base, db, fake, original, kids, locked, service } = await startMultiDevice(t);
  const browser = new Browser(base);
  const guest = new Browser(base);
  const usedCode = await pair(browser, original.id, 'Sala');
  assert.equal((await activate(guest, usedCode)).status, 400);

  const unusedCode = await pairCode(browser, kids.id, 'Quarto');
  await service.setPasscode(kids.id, { code: '2468' });
  assert.equal((await activate(guest, unusedCode)).status, 400);
  assert.equal((await guest.request('/devices/history.json')).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mp_devices').get().count, 1);

  guest.jar.set('mp_device', browser.jar.get('mp_device'));
  const signedOut = await guest.request('/devices/select-profile', { method: 'POST', form: { profileId: original.id } });
  assert.equal(signedOut.location, '/signin');

  const profileOfDevice = () => db.prepare('SELECT profile_id FROM mp_devices WHERE label=?').get('Sala').profile_id;
  const fields = { _csrf: await browser.csrf(), profileId: locked.id };
  const crossOrigin = await fetch(base + '/devices/select-profile', {
    method: 'POST',
    headers: { cookie: browser.cookie, origin: 'https://other.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  assert.equal(crossOrigin.status, 403);

  const originalUser = fake.user;
  fake.user = { _id: 'other-user', email: 'other@example.com' };
  try {
    const signIn = await guest.request('/signin', {
      method: 'POST', form: { email: fake.user.email, password: fake.password },
    });
    assert.equal(signIn.location, '/configure');
  } finally {
    fake.user = originalUser;
  }
  const other = accounts.forAccount(2).repo.listProfiles()[0];
  await select(guest, other.id);
  assert.match((await guest.request('/configure')).text, /Pareie este navegador com esta conta/);
  await select(browser, other.id);
  assert.match((await browser.request('/configure')).text, /Perfil indisponível/);
  assert.equal(profileOfDevice(), original.id);

  await service.deleteProfile(kids.id);
  await select(browser, kids.id);
  assert.match((await browser.request('/configure')).text, /Perfil indisponível/);

  db.prepare('UPDATE mp_devices SET expires_at=? WHERE label=?').run(Date.now() - 1, 'Sala');
  await select(browser, original.id);
  assert.match((await browser.request('/configure')).text, /Pareie este navegador com esta conta/);
  assert.equal(profileOfDevice(), original.id);
  assert.equal((await browser.request('/devices/history.json')).status, 401);
});
