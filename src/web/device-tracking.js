import express from 'express';
import crypto from 'node:crypto';
import { esc } from './device-core.js';
import { digestToken, newToken, validToken, nativeManifest, parseNativeEvent, TRACKING_RETENTION_MS, TRACKING_MAX_EVENTS_PER_ACCOUNT } from './device-tracking-core.js';

/**
 * Collects account-level native events and passes probable matches to the opt-in history.
 * The install token authorizes collection for the account. It carries no device identity.
 */
export function createNativeTrackingRouter({db, auth, config, originOkay, page, nativeHistory, resolveBridge}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mp_tracking_installs (
      id TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mp_tracking_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      install_id TEXT NOT NULL REFERENCES mp_tracking_installs(id) ON DELETE CASCADE,
      type TEXT NOT NULL, video_id TEXT NOT NULL, action TEXT NOT NULL,
      current_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mp_tracking_events_account ON mp_tracking_events(account_id, received_at);
    CREATE TABLE IF NOT EXISTS mp_native_history_outcomes (
      event_id INTEGER PRIMARY KEY REFERENCES mp_tracking_events(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    );
  `);
  const router = express.Router();
  const activeInstall = db.prepare('SELECT * FROM mp_tracking_installs WHERE token_hash=? AND revoked_at IS NULL');
  const listInstalls = db.prepare('SELECT id, created_at FROM mp_tracking_installs WHERE account_id=? AND revoked_at IS NULL ORDER BY created_at DESC');
  const listEvents = db.prepare(`SELECT e.type, e.video_id AS videoId, e.action, e.current_ms AS currentMs,
    e.duration_ms AS durationMs, e.received_at AS receivedAt,
    CASE WHEN h.undone_at IS NOT NULL THEN 'undone' ELSE o.status END AS status
    FROM mp_tracking_events e LEFT JOIN mp_native_history_outcomes o ON o.event_id=e.id
    LEFT JOIN mp_native_history_events h ON h.source_event_id=e.id
    WHERE e.account_id=? ORDER BY e.id DESC LIMIT 30`);
  const addInstall = db.prepare('INSERT INTO mp_tracking_installs (id, account_id, token_hash, created_at) VALUES (?,?,?,?)');
  const revoke = db.prepare('UPDATE mp_tracking_installs SET revoked_at=? WHERE id=? AND account_id=? AND revoked_at IS NULL');
  const insertEvent = db.prepare(`INSERT INTO mp_tracking_events
    (account_id,install_id,type,video_id,action,current_ms,duration_ms,received_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const expireEvents = db.prepare('DELETE FROM mp_tracking_events WHERE received_at<?');
  const pruneAccount = db.prepare(`DELETE FROM mp_tracking_events WHERE account_id=? AND id NOT IN
    (SELECT id FROM mp_tracking_events WHERE account_id=? ORDER BY id DESC LIMIT ?)`);
  const saveOutcome = db.prepare('INSERT INTO mp_native_history_outcomes (event_id,status) VALUES (?,?)');
  const attribute = db.transaction(({req, accountId, eventId, event, now}) => {
    const match = resolveBridge()?.suggest({req, accountId, eventId, now}) ?? { status: 'unmatched' };
    saveOutcome.run(eventId, nativeHistory.record({accountId, eventId, event, match, now}));
  });
  const receive = db.transaction((req, installation, event, now) => {
    const accountId = installation.account_id;
    const { lastInsertRowid } = insertEvent.run(accountId, installation.id, event.type, event.videoId,
      event.action, event.currentMs, event.durationMs, now);
    try {
      attribute({req, accountId, eventId: Number(lastInsertRowid), event, now});
    } catch (error) {
      // Keep the raw diagnostic event if the experimental assignment fails.
      console.error('[MultiDevice network diagnostic] Failed to attribute tentative event:', error.message);
    }
    expireEvents.run(now - TRACKING_RETENTION_MS);
    pruneAccount.run(accountId, accountId, TRACKING_MAX_EVENTS_PER_ACCOUNT);
  });
  const outcomes = {
    assigned: 'Atribuição experimental por rede',
    ambiguous: 'Sem atribuição (rede ambígua)',
    disabled: 'Sem atribuição (experimento desativado)',
    duplicate: 'Sem nova atribuição (evento repetido)',
    'profile-unavailable': 'Sem atribuição (perfil indisponível)',
    'no-start': 'Sem atribuição (sem início compatível)',
    undone: 'Atribuição desfeita',
  };
  const getInstall = token => validToken(token) ? activeInstall.get(digestToken(token)) : null;
  const cors = (req,res,next) => {
    res.set('Access-Control-Allow-Origin','*');
    res.set('Access-Control-Allow-Methods','GET, OPTIONS');
    res.set('Cache-Control','no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
  router.use('/addon', cors);
  const clean = () => expireEvents.run(Date.now()-TRACKING_RETENTION_MS);
  const csrf = req => `<input type="hidden" name="_csrf" value="${esc(req.session.csrf)}">`;
  const dashboard = (req,res,extra='') => {
    clean();
    const accountId = req.session.accountId;
    const installs = listInstalls.all(accountId);
    const events = listEvents.all(accountId);
    page(res,'Tracking nativo — diagnóstico',`
      <p><strong>Experimento:</strong> recebe ações do player nativo de todos os aparelhos da conta Stremio que enviarem eventos. A atribuição provável por rede depende da ativação voluntária no navegador pareado.</p>
      <p>Não registramos IP, User-Agent ou endereço MAC. Os eventos ficam armazenados por até 7 dias e no máximo ${TRACKING_MAX_EVENTS_PER_ACCOUNT} por conta.</p>
      ${extra}
      <h2>Autorizar um coletor de testes</h2>
      <form method="post" action="/devices/tracking/new">${csrf(req)}
        <label><input type="checkbox" name="consent" value="yes" required> Autorizo o recebimento dos eventos de reprodução da minha conta de teste e entendo que eles poderão incluir os outros aparelhos conectados à mesma conta.</label>
        <button>Gerar instalação privada</button>
      </form>
      <h2>Instalações ativas</h2>${installs.length ? `<ul>${installs.map(d=>`<li>${esc(d.id.slice(0,8))} — criada em ${new Date(d.created_at).toISOString().slice(0,10)}
          <form method="post" action="/devices/tracking/revoke">${csrf(req)}<input type="hidden" name="id" value="${esc(d.id)}"><button>Revogar coletor</button></form></li>`).join('')}</ul>`:'<p>Nenhuma instalação.</p>'}
      <h2>Eventos recebidos</h2>
      ${events.length ? `<ol>${events.map(e=>`<li>${esc(e.type)} · ${esc(e.videoId)} · ${esc(e.action)} · ${Math.round(e.currentMs/1000)}s / ${Math.round(e.durationMs/1000)}s · ${new Date(e.receivedAt).toISOString()} · ${outcomes[e.status] ?? 'Sem atribuição'}</li>`).join('')}</ol>`:'<p>Nenhum evento recebido ainda.</p>'}
      <p><a href="/devices">Voltar aos aparelhos</a> · <a href="/devices/native-history">Histórico experimental do Stremio</a></p>`);
  };
  router.get('/',auth.require,(req,res)=>dashboard(req,res));
  router.post('/new',auth.require,auth.csrf,originOkay,(req,res)=> {
    if (req.body?.consent !== 'yes') return res.status(400).send('Consentimento obrigatório.');
    const token = newToken();
    const id = crypto.randomUUID();
    addInstall.run(id,req.session.accountId,digestToken(token),Date.now());
    const manifestUrl = `${config.publicUrl.replace(/\/$/,'')}/devices/tracking/addon/${token}/manifest.json`;
    // The unguessable installation URL is displayed once and stored only hashed.
    dashboard(req,res,`<h2>Instalação gerada — copie agora</h2><p>Use somente na conta Stremio de teste. Link privado; quem o conhecer pode enviar eventos falsos. Não compartilhe em capturas.</p><p><code style="overflow-wrap:anywhere">${esc(manifestUrl)}</code></p><p>O Stremio pedirá consentimento explícito para compartilhar atividades. Se não houver aviso, não prossiga.</p>`);
  });
  router.post('/revoke',auth.require,auth.csrf,originOkay,(req,res)=> {
    const id = String(req.body?.id || '');
    revoke.run(Date.now(),id,req.session.accountId);
    res.redirect(303,'/devices/tracking');
  });
  router.get('/addon/:token/manifest.json',(req,res)=> {
    if (!getInstall(req.params.token)) return res.status(404).json({error:'Instalação indisponível'});
    res.json(nativeManifest(req.params.token));
  });
  router.get('/addon/:token/player/:type/:videoId/:extra.json',(req,res)=> {
    const installation = getInstall(req.params.token);
    if (!installation) return res.status(404).json({success:false});
    const event = parseNativeEvent(req.params.type,req.params.videoId,req.params.extra);
    if (!event) return res.status(400).json({success:false});
    receive.immediate(req, installation, event, Date.now());
    res.json({success:true});
  });
  return router;
}
