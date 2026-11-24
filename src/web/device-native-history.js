import { randomUUID } from 'node:crypto';
import express from 'express';
import { esc } from './device-core.js';

const RETRY_WINDOW_MS = 10_000;
const REVIEW_PAGE_SIZE = 30;

function positiveId(value) {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}

/** Stores probable assignments independently of the expiring Tracking diagnostics. */
export function createDeviceNativeHistory({ db, auth, originOkay, page, currentBrowser }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mp_native_history_opt_ins (
      device_id TEXT PRIMARY KEY REFERENCES mp_devices(id) ON DELETE CASCADE,
      context_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mp_native_history_events (
      source_event_id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES mp_devices(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      context_id TEXT NOT NULL,
      playback_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      video_id TEXT NOT NULL,
      action TEXT NOT NULL,
      current_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      undone_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mp_native_history_device_video
      ON mp_native_history_events(device_id, type, video_id, source_event_id DESC);
    CREATE INDEX IF NOT EXISTS mp_native_history_profile
      ON mp_native_history_events(account_id, profile_id, playback_id) WHERE undone_at IS NULL;
  `);

  const getOptIn = db.prepare('SELECT context_id FROM mp_native_history_opt_ins WHERE device_id=?');
  const enable = db.prepare('INSERT OR IGNORE INTO mp_native_history_opt_ins (device_id,context_id) VALUES (?,?)');
  const disable = db.prepare('DELETE FROM mp_native_history_opt_ins WHERE device_id=?');
  const newContext = db.prepare('UPDATE mp_native_history_opt_ins SET context_id=? WHERE device_id=?');
  const eligibleProfiles = db.prepare(`SELECT id,name FROM profiles
    WHERE account_id=? AND deleted_at IS NULL AND passcode_hash IS NULL ORDER BY id`);
  const retry = db.prepare(`SELECT 1 FROM mp_native_history_events
    WHERE device_id=@deviceId AND type=@type AND video_id=@videoId AND action=@action
      AND current_ms=@currentMs AND duration_ms=@durationMs AND received_at>=@cutoff LIMIT 1`);
  const last = db.prepare(`SELECT context_id, profile_id, playback_id, action, undone_at
    FROM mp_native_history_events WHERE device_id=? AND type=? AND video_id=?
    ORDER BY source_event_id DESC LIMIT 1`);
  const insert = db.prepare(`INSERT INTO mp_native_history_events
    (source_event_id,account_id,device_id,profile_id,context_id,playback_id,type,video_id,action,current_ms,duration_ms,received_at)
    VALUES (@eventId,@accountId,@deviceId,@profileId,@contextId,@playbackId,@type,@videoId,@action,@currentMs,@durationMs,@now)`);
  const progress = db.prepare(`SELECT type,video_id,MAX(MIN(current_ms,duration_ms)) AS position_ms
    FROM mp_native_history_events WHERE account_id=? AND profile_id=? AND undone_at IS NULL
    GROUP BY type,video_id ORDER BY MAX(source_event_id) DESC LIMIT 100`);
  const playbacks = db.prepare(`SELECT e.playback_id,e.video_id,d.label,MAX(e.received_at) AS received_at
    FROM mp_native_history_events e JOIN mp_devices d ON d.id=e.device_id
    WHERE e.account_id=? AND e.profile_id=? AND e.undone_at IS NULL AND e.playback_id<?
    GROUP BY e.playback_id,e.video_id,d.label ORDER BY e.playback_id DESC LIMIT ?`);
  const undo = db.prepare(`UPDATE mp_native_history_events SET undone_at=?
    WHERE account_id=? AND playback_id=? AND undone_at IS NULL
      AND EXISTS (SELECT 1 FROM profiles p WHERE p.id=mp_native_history_events.profile_id
        AND p.account_id=mp_native_history_events.account_id AND p.deleted_at IS NULL AND p.passcode_hash IS NULL)
    RETURNING profile_id`);

  function resetPlayback(deviceId) {
    newContext.run(randomUUID(), deviceId);
  }

  /** Called in the same database transaction as receipt and network matching. */
  function record({ accountId, event, eventId, match, now }) {
    // A shared IP interrupts the evidence for the old sessions. If the network
    // later has only one candidate again, a late pause must still wait for a start.
    if (match.status === 'ambiguous') {
      for (const candidate of match.candidates) resetPlayback(candidate.device_id);
    }
    if (match.status !== 'possible') return match.status;
    const { device_id: deviceId, profile_id: profileId, profile_available: profileAvailable } = match.candidate;
    const optIn = getOptIn.get(deviceId);
    if (!optIn) return 'disabled';
    if (!profileAvailable) return 'profile-unavailable';
    // The protocol has no event ID. Ignore exact repeats within a short window,
    // even after a profile change or undo. A different device has its own window.
    if (retry.get({ deviceId, ...event, cutoff: now - RETRY_WINDOW_MS })) return 'duplicate';

    const contextId = optIn.context_id;
    const previous = last.get(deviceId, event.type, event.videoId);
    const continuing = previous?.context_id === contextId && previous.profile_id === profileId &&
      previous.undone_at === null && previous.action !== 'stop';
    if (event.action !== 'start' && !continuing) return 'no-start';
    insert.run({
      accountId, eventId, deviceId, profileId, contextId, playbackId: continuing ? previous.playback_id : eventId, now, ...event,
    });
    return 'assigned';
  }

  const router = express.Router();
  const path = '/devices/native-history';
  const csrf = req => `<input type="hidden" name="_csrf" value="${esc(req.session.csrf)}">`;
  router.get('/', auth.require, (req, res) => {
    const accountId = req.session.accountId;
    const browser = currentBrowser(req);
    const active = browser && getOptIn.get(browser.id);
    const profiles = eligibleProfiles.all(accountId);
    const profile = profiles.find(p => String(p.id) === req.query.profileId) ??
      profiles.find(p => p.id === browser?.profile_id) ?? profiles[0];
    const items = profile ? progress.all(accountId, profile.id) : [];
    const before = positiveId(req.query.before) ?? Number.MAX_SAFE_INTEGER;
    const review = profile ? playbacks.all(accountId, profile.id, before, REVIEW_PAGE_SIZE + 1) : [];
    const more = review.length > REVIEW_PAGE_SIZE;
    if (more) review.pop();
    page(res, 'Histórico experimental do Stremio', `
      <p>A associação é uma hipótese de rede. Outros aparelhos na mesma conexão podem gerar eventos parecidos.</p>
      <p>Com o experimento ativo, um início de reprodução (<code>start</code>) abre uma sessão para o perfil selecionado. Mudanças de perfil ou de associação exigem um novo início. A lista mostra a maior posição ainda atribuída a cada vídeo.</p>
      <p><a href="/devices/bridge">Associação de rede</a> · <a href="/devices/tracking">Diagnóstico do Tracking Addon</a> · <a href="/devices">Gerenciar aparelhos</a></p>
      <h2>Experimento neste navegador</h2>
      ${browser ? active
        ? `<form method="post" action="${path}/disable">${csrf(req)}<button>Desativar atribuição automática</button></form><p>Desativar pausa novas atribuições e mantém as anteriores.</p>`
        : `<form method="post" action="${path}/enable">${csrf(req)}
            <label><input type="checkbox" name="consent" value="yes" required> Aceito usar a associação de rede para atribuir eventos prováveis ao perfil deste aparelho. Entendo que eventos de outros aparelhos podem ser atribuídos por engano.</label>
            <button>Ativar atribuição experimental</button></form>`
        : '<p>Pareie este navegador com esta conta para ativar a atribuição automática.</p>'}
      <h2>Progresso experimental por perfil</h2>
      ${profile ? `<form method="get" action="${path}">
        <label>Perfil <select name="profileId">${profiles.map(p => `<option value="${p.id}"${p.id === profile.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <button>Ver progresso</button></form>
        <p><a href="/devices/history-catalog?profileId=${profile.id}">Autorizar catálogo no Stremio</a></p>` : ''}
      ${items.length ? `<ul>${items.map(item => `<li>${esc(item.video_id)} · ${Math.floor(item.position_ms / 1000)} s · hipótese por rede</li>`).join('')}</ul>` : '<p>Nenhum progresso atribuído a este perfil.</p>'}
      <h2>Atribuições para revisar</h2>
      ${review.length ? `<ol>${review.map(item => `<li>${esc(item.video_id)} · ${esc(item.label)} · ${new Date(item.received_at).toISOString()}
        <form method="post" action="${path}/undo">${csrf(req)}
          <input type="hidden" name="playbackId" value="${item.playback_id}"><button>Desfazer atribuição</button>
        </form></li>`).join('')}</ol>` : '<p>Nenhuma atribuição para revisar.</p>'}
      ${more ? `<p><a href="${path}?profileId=${profile.id}&amp;before=${review.at(-1).playback_id}">Ver atribuições anteriores</a></p>` : ''}`);
  });
  router.post('/enable', auth.require, auth.csrf, originOkay, (req, res) => {
    const browser = currentBrowser(req);
    if (!browser) return res.status(403).send('Pareie este navegador com esta conta.');
    if (req.body?.consent !== 'yes') return res.status(400).send('Consentimento obrigatório.');
    enable.run(browser.id, randomUUID());
    return res.redirect(303, path);
  });
  router.post('/disable', auth.require, auth.csrf, originOkay, (req, res) => {
    const browser = currentBrowser(req);
    if (!browser) return res.status(403).send('Pareie este navegador com esta conta.');
    disable.run(browser.id);
    return res.redirect(303, path);
  });
  router.post('/undo', auth.require, auth.csrf, originOkay, (req, res) => {
    const playbackId = positiveId(req.body?.playbackId);
    if (!playbackId) return res.status(400).send('Atribuição inválida.');
    const item = undo.get(Date.now(), req.session.accountId, playbackId);
    if (!item) return res.status(404).send('Atribuição indisponível.');
    return res.redirect(303, `${path}?profileId=${item.profile_id}`);
  });
  return { router, record, resetPlayback };
}
