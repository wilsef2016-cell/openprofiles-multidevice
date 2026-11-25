import express from 'express';
import crypto from 'node:crypto';
import { esc } from './device-core.js';
import { NETWORK_TTL_MS, networkDigest, candidateForNetwork, publicIp } from './device-bridge-core.js';

/**
 * Optional browser-network companion for native Stremio events.
 * IP address is a weak, shared network signal, never a device identifier.
 * This bridge writes only TENTATIVE suggestions, never mp_progress/native history.
 */
// MULTIDEVICE_REALIP_V041: read client IP from Railway's sanitized public HTTPS ingress.
// Only a tentative network correlation; NEVER use this as authentication or device proof.
// Direct private-network requests can forge forwarded headers, so do not use this
// signal for access control or for overwriting verified per-profile progress.
function observedIp(req, config) {
  const expectedHost = new URL(config.publicUrl).host;
  const edgeHost = req.get('x-forwarded-host');
  const edgeProto = req.get('x-forwarded-proto');
  const realIp = req.get('x-real-ip');
  if (req.get('host') === expectedHost && edgeHost === expectedHost &&
      edgeProto === 'https' && publicIp(realIp)) return realIp;
  return req.ip;
}

export function createDeviceNetworkBridge({db, requireDevice, originOkay, page, config, resetPlayback}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mp_bridge_secret (
      id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mp_bridge_bindings (
      device_id TEXT PRIMARY KEY REFERENCES mp_devices(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      ip_hash TEXT NOT NULL, activated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mp_bridge_account ON mp_bridge_bindings(account_id, ip_hash, expires_at);
    CREATE TABLE IF NOT EXISTS mp_bridge_candidates (
      event_id INTEGER PRIMARY KEY REFERENCES mp_tracking_events(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES mp_devices(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      matched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mp_bridge_device ON mp_bridge_candidates(device_id, matched_at);
  `);
  db.prepare('INSERT OR IGNORE INTO mp_bridge_secret(id,value) VALUES(1,?)')
    .run(crypto.randomBytes(32).toString('hex'));
  const secret = db.prepare('SELECT value FROM mp_bridge_secret WHERE id=1').get().value;
  const router = express.Router();
  const getBinding = db.prepare('SELECT * FROM mp_bridge_bindings WHERE device_id=?');
  const upsertBinding = db.prepare(`INSERT INTO mp_bridge_bindings (device_id,account_id,ip_hash,activated_at,expires_at)
    VALUES (?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET ip_hash=excluded.ip_hash,
    activated_at=excluded.activated_at,expires_at=excluded.expires_at,account_id=excluded.account_id`);
  const removeBinding = db.prepare('DELETE FROM mp_bridge_bindings WHERE device_id=?');
  const findBindings = db.prepare(`SELECT b.*, d.profile_id, d.expires_at AS device_expires_at, d.revoked_at,
      p.id IS NOT NULL AS profile_available
    FROM mp_bridge_bindings b JOIN mp_devices d ON d.id=b.device_id AND d.account_id=b.account_id
    LEFT JOIN profiles p ON p.id=d.profile_id AND p.account_id=d.account_id
      AND p.deleted_at IS NULL AND p.passcode_hash IS NULL
    WHERE b.account_id=? AND b.ip_hash=? AND b.expires_at>?`);
  const insertCandidate = db.prepare(`INSERT OR IGNORE INTO mp_bridge_candidates
    (event_id,account_id,device_id,profile_id,matched_at) VALUES(?,?,?,?,?)`);
  const recentCandidates = db.prepare(`SELECT e.type,e.video_id AS videoId,e.action,
      e.current_ms AS currentMs,e.received_at AS receivedAt
    FROM mp_bridge_candidates c JOIN mp_tracking_events e ON e.id=c.event_id
    WHERE c.device_id=? ORDER BY c.matched_at DESC LIMIT 20`);
  const prune = db.prepare('DELETE FROM mp_bridge_bindings WHERE expires_at < ?');
  const pruneCandidates = db.prepare('DELETE FROM mp_bridge_candidates WHERE matched_at < ? OR event_id NOT IN (SELECT id FROM mp_tracking_events)');
  const clean = (now=Date.now()) => { prune.run(now); pruneCandidates.run(now - 7*24*60*60*1000); };
  const bind = db.transaction((device, hash, now) => {
    upsertBinding.run(device.id,device.account_id,hash,now,now+NETWORK_TTL_MS);
    resetPlayback(device.id);
    clean(now);
  });
  const removeCandidates = db.prepare('DELETE FROM mp_bridge_candidates WHERE device_id=?');
  const unbind = db.transaction((deviceId) => {
    removeBinding.run(deviceId);
    removeCandidates.run(deviceId);
    resetPlayback(deviceId);
  });

  function matchNetwork(accountId, ip, now) {
    const hash = networkDigest(secret, ip);
    const bindings = hash ? findBindings.all(accountId,hash,now) : [];
    return candidateForNetwork(bindings,hash,now);
  }

  // Catalog reads use only the connection address or Express's address-based
  // proxy chain. The legacy X-Real-IP hint is useful for diagnostics only.
  function matchCatalogNetwork(req, accountId, now = Date.now()) {
    const trust = config.trustProxy;
    const ip = trust === true || typeof trust === 'number' ? req.socket.remoteAddress : req.ip;
    return matchNetwork(accountId, ip, now);
  }

  function suggest({req,accountId,eventId,now=Date.now()}) {
    clean(now);
    const match = matchNetwork(accountId, observedIp(req, config), now);
    if (match.status === 'possible') {
      const device = match.candidate;
      insertCandidate.run(eventId,accountId,device.device_id,device.profile_id,now);
    }
    return match;
  }
  router.get('/',requireDevice,(req,res) => {
    clean();
    const d = req.mpDevice;
    const binding = getBinding.get(d.id);
    const active = Boolean(binding?.expires_at > Date.now());
    const items = recentCandidates.all(d.id);
    page(res,'Ponte automática — diagnóstico',`
      <p><strong>Atenção:</strong> o navegador não consegue fornecer o MAC. Esta ponte registra somente um hash protegido do IP público observado, por até 24 horas. O mesmo IP pode ser compartilhado por vários aparelhos e o Stremio pode usar servidores intermediários.</p>
      <p>A correspondência de IP é uma <strong>hipótese</strong>. A ativação da ponte habilita o diagnóstico. A atribuição automática ao histórico experimental exige consentimento adicional.</p>
      <p><strong>Aparelho:</strong> ${esc(d.label)} · <strong>Perfil:</strong> ${esc(d.profile_name)}</p>
      <p><strong>Associação de rede:</strong> ${active ? `ativa até ${new Date(binding.expires_at).toISOString()}` : 'não ativada ou expirada'}</p>
      <form method="post" action="/devices/bridge/enable">
        <label><input type="checkbox" name="consent" value="yes" required>
          Autorizo o uso temporário de um hash da minha conexão pública para sugerir correspondências com os eventos da conta Stremio de teste. Entendo o risco de erros em casas com múltiplos aparelhos.</label>
        <button>${active ? 'Atualizar associação por 24 horas' : 'Ativar associação de rede'}</button>
      </form>
      <form method="post" action="/devices/bridge/disable"><button>Desativar e apagar associação</button></form>
      <h2>Eventos possivelmente relacionados</h2>
      ${items.length ? `<ol>${items.map(x=>`<li>${esc(x.type)} · ${esc(x.videoId)} · ${esc(x.action)} · ${Math.round(x.currentMs/1000)}s · ${new Date(x.receivedAt).toISOString()} <strong>(hipótese por rede)</strong></li>`).join('')}</ol>` : '<p>Nenhum candidato ainda.</p>'}
      <p><a href="/devices/me">Voltar ao aparelho</a> · <a href="/devices/tracking">Ver eventos nativos</a> · <a href="/devices/native-history">Histórico experimental do Stremio</a></p>`);
  });
  router.post('/enable',requireDevice,originOkay,(req,res) => {
    if (req.body?.consent !== 'yes') return res.status(400).send('Consentimento obrigatório');
    const hash = networkDigest(secret,observedIp(req, config));
    if (!hash) return res.status(422).send('Não foi possível observar um IP público válido. O serviço pode estar atrás de um proxy. Nada foi registrado.');
    bind(req.mpDevice,hash,Date.now());
    res.redirect(303,'/devices/bridge');
  });
  router.post('/disable',requireDevice,originOkay,(req,res) => {
    unbind(req.mpDevice.id);
    res.redirect(303,'/devices/bridge');
  });
  return {router,suggest,matchCatalogNetwork};
}
