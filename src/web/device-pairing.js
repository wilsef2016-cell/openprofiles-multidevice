import express from 'express';
import crypto from 'node:crypto';
import { createNativeTrackingRouter } from './device-tracking.js';
import { createDeviceNetworkBridge } from './device-network-bridge.js';
import { fileURLToPath } from 'node:url';
import { renderDevicePlayer } from './device-player-page.js';
import {CODE_TTL_MS,DEVICE_TTL_MS,esc,normalizedCode,pairingCode,randomSecret,sameSiteRequest,sha,validProgress} from './device-core.js';

/**
 * Integração opcional com o OpenProfiles (v1.2.4, estrutura consultada em 2026-11).
 * Não intercepta nem altera a API nativa da conta Stremio.
 * A sessão de aparelho é vinculada a ESTE navegador/cliente, não ao IP ou MAC.
 */
export function createDevicePairingRouter({ db, auth, config }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mp_pair_codes (
      code_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      label TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mp_devices (
      id TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mp_devices_account ON mp_devices(account_id, revoked_at);
    CREATE TABLE IF NOT EXISTS mp_progress (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL, media_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, current_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      action TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES mp_devices(id) ON DELETE CASCADE,
      updated_at INTEGER NOT NULL, PRIMARY KEY(account_id,profile_id,video_id)
    );
  `);
  const router = express.Router();
  const profilesFor = db.prepare('SELECT id, name FROM profiles WHERE account_id = ? AND deleted_at IS NULL AND passcode_hash IS NULL ORDER BY id');
  const profileExists = db.prepare('SELECT id, name FROM profiles WHERE account_id = ? AND id = ? AND deleted_at IS NULL AND passcode_hash IS NULL');
  const devicesFor = db.prepare(`SELECT d.id, d.label, p.name AS profile_name, d.created_at, d.expires_at
     FROM mp_devices d JOIN profiles p ON p.id=d.profile_id WHERE d.account_id=? AND d.revoked_at IS NULL ORDER BY d.created_at DESC`);
  const insertCode = db.prepare(`INSERT INTO mp_pair_codes(code_hash, account_id, profile_id, label, expires_at) VALUES (?,?,?,?,?)`);
  const lookupCode = db.prepare('SELECT * FROM mp_pair_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?');
  const spendCode = db.prepare('UPDATE mp_pair_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL');
  const addDevice = db.prepare(`INSERT INTO mp_devices(id,account_id,profile_id,label,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`);
  const deviceByToken = db.prepare(`SELECT d.*, p.name AS profile_name FROM mp_devices d
    JOIN profiles p ON p.id=d.profile_id WHERE d.token_hash=? AND d.revoked_at IS NULL AND d.expires_at>? AND p.deleted_at IS NULL AND p.passcode_hash IS NULL`);
  const revokeOne = db.prepare('UPDATE mp_devices SET revoked_at=? WHERE account_id=? AND id=? AND revoked_at IS NULL');
  const revokeToken = db.prepare('UPDATE mp_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL');
  const listProgress = db.prepare(`SELECT media_id AS mediaId,video_id AS videoId,type,title,current_ms AS currentMs,
    duration_ms AS durationMs,action,updated_at AS updatedAt FROM mp_progress WHERE account_id=? AND profile_id=? ORDER BY updated_at DESC LIMIT 100`);
  const updateProgress = db.prepare(`INSERT INTO mp_progress (account_id,profile_id,video_id,media_id,type,title,current_ms,duration_ms,action,device_id,updated_at)
    VALUES (@account_id,@profile_id,@video_id,@media_id,@type,@title,@current_ms,@duration_ms,@action,@device_id,@updated_at)
    ON CONFLICT(account_id,profile_id,video_id) DO UPDATE SET
    media_id=excluded.media_id,type=excluded.type,title=excluded.title,current_ms=excluded.current_ms,
    duration_ms=excluded.duration_ms,action=excluded.action,device_id=excluded.device_id,updated_at=excluded.updated_at`);

  const layout = (title, content) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · MultiProfiles</title><link rel="stylesheet" href="/theme.css"></head><body><main><h1>${esc(title)}</h1><p><a href="/configure">Voltar ao OpenProfiles</a> · <a href="/devices/activate">Parear aparelho</a></p>${content}</main></body></html>`;
  const page = (res, title, content, status = 200) => res.status(status).set('Cache-Control','no-store').type('html').send(layout(title,content));
  const cookieName = 'mp_device';
  const parseCookie = (req) => (req.get('cookie') || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1) || '';
  const device = req => { const secret=parseCookie(req);return secret ? deviceByToken.get(sha(secret),Date.now()) : null; };
  const setCookie = (res, token, ageMs) => {
    const flags = [`${cookieName}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/devices', `Max-Age=${Math.floor(ageMs/1000)}`];
    if (config.publicUrl.startsWith('https://')) flags.push('Secure');
    res.set('Set-Cookie',flags.join('; '));
  };
  const originOkay = (req,res,next) => sameSiteRequest(req,config.publicUrl) ? next() : res.status(403).send('Origem não autorizada');
  // MULTIDEVICE_COOKIE_V03: migra cookies Strict antigos ao abrir uma pagina autenticada.
  // A duracao e sempre limitada ao vencimento original no banco; nao renova o token.
  const requireDevice = (req,res,next) => {
    req.mpDevice = device(req);
    if (!req.mpDevice) return res.status(401).set('Cache-Control','no-store').type('text').send('Aparelho não pareado ou sessão expirada. Abra /devices/activate.');
    if (req.method === 'GET' && (req.path === '/me' || req.path === '/player')) {
      const token = parseCookie(req);
      const remainingMs = Math.max(0, req.mpDevice.expires_at - Date.now());
      setCookie(res, token, remainingMs);
    }
    return next();
  };
  // MULTIDEVICE_TRACKING_V03: eventos nativos SEM atribuição a aparelho/perfil.
  // MULTIDEVICE_NETWORK_BRIDGE_V04: ponte por rede, nunca altera mp_progress.
  let networkBridge;
  router.use('/tracking', createNativeTrackingRouter({ db, auth, config, originOkay, page, resolveBridge: () => networkBridge }));
  networkBridge = createDeviceNetworkBridge({ db, requireDevice, originOkay, page });
  router.use('/bridge', networkBridge.router);
  router.get('/',auth.require,(req,res)=> {
    const profiles=profilesFor.all(req.session.accountId);
    const devices=devicesFor.all(req.session.accountId);
    page(res,'Aparelhos e perfis',`<p><strong>Modo experimental:</strong> cada navegador pareado recebe uma sessão própria; o Stremio nativo NÃO envia essa identidade ao addon. Perfis com PIN não são pareáveis nesta versão.</p><p>Gere um código para o aparelho e digite-o no navegador desse aparelho dentro de 5 minutos.</p>
      <form method="post" action="/devices/new-pair"><input type="hidden" name="_csrf" value="${esc(req.session.csrf)}"><label>Perfil <select name="profileId">${profiles.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>Nome do aparelho <input name="label" maxlength="50" required placeholder="TV da sala"></label><button>Gerar código</button></form>
      <p><a href="/devices/tracking">Rastreamento nativo experimental (sem perfil atribuído)</a> · <a href="/devices/bridge">Associação automática por rede (experimental)</a></p>
      <h2>Aparelhos ativos</h2>${devices.length?`<ul>${devices.map(d=>`<li>${esc(d.label)} — ${esc(d.profile_name)} <form method="post" action="/devices/revoke"><input type="hidden" name="_csrf" value="${esc(req.session.csrf)}"><input type="hidden" name="id" value="${esc(d.id)}"><button>Revogar</button></form></li>`).join('')}</ul>`:'<p>Nenhum aparelho vinculado.</p>'}
      <p><a href="/devices/activate">Ativar neste aparelho</a></p>`);
  });
  router.post('/new-pair',auth.require,auth.csrf,originOkay,(req,res)=> {
    const profileId=Number(req.body?.profileId);const label=String(req.body?.label||'').trim().slice(0,50);
    if(!label||!Number.isSafeInteger(profileId)||!profileExists.get(req.session.accountId,profileId))return res.status(400).send('Perfil ou nome inválido');
    const code=pairingCode();const now=Date.now();
    db.prepare('DELETE FROM mp_pair_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(now);
    insertCode.run(sha(code),req.session.accountId,profileId,label,now+CODE_TTL_MS);
    page(res,'Código de pareamento',`<p>Para <strong>${esc(label)}</strong>: digite este código no navegador desse aparelho em <strong>${esc(config.publicUrl)}/devices/activate</strong>:</p><h2><code>${code}</code></h2><p>Válido por 5 minutos, uma única utilização. Não compartilhe publicamente.</p><p><a href="/devices">Voltar</a></p>`);
  });
  router.post('/revoke',auth.require,auth.csrf,originOkay,(req,res)=> {
    const id=String(req.body?.id||'');revokeOne.run(Date.now(),req.session.accountId,id);res.redirect(303,'/devices');
  });
  router.get('/activate',(req,res)=>page(res,'Ativar aparelho',`<p>Digite o código criado pelo administrador do perfil. Use o navegador do aparelho que você deseja identificar.</p><form method="post" action="/devices/activate"><label>Código <input name="code" minlength="12" maxlength="18" autocomplete="off" required></label><button>Ativar</button></form>`));
  // Rate limiting only against guessing pairing codes; not used as an identity signal.
  const attempts=new Map();
  router.post('/activate',originOkay,(req,res)=> {
    const ip=String(req.ip||'unknown');const now=Date.now();
    if(attempts.size>3000){for(const [key,val] of attempts)if(val.until<now)attempts.delete(key);if(attempts.size>3000)attempts.clear();}
    const entry=attempts.get(ip);if(entry&&entry.until>now&&entry.count>=10)return page(res,'Tente mais tarde','<p>Muitas tentativas. Aguarde alguns minutos.</p>',429);
    attempts.set(ip,{count:(entry?.until>now?entry.count:0)+1,until:now+10*60_000});
    const code=normalizedCode(req.body?.code);
    if(code.length!==12)return page(res,'Código inválido','<p>Confira o código ou gere outro.</p>',400);
    const consume = db.transaction(() => {
      const record=lookupCode.get(sha(code),now);
      if(!record)return null;
      if(spendCode.run(now,record.code_hash).changes!==1)return null;
      const token=randomSecret(32);const id=crypto.randomUUID();
      addDevice.run(id,record.account_id,record.profile_id,record.label,sha(token),now,now+DEVICE_TTL_MS);
      return token;
    });
    const token=consume();if(!token)return page(res,'Código inválido','<p>Código expirado ou já utilizado. Gere outro.</p>',400);
    attempts.delete(ip);setCookie(res,token,DEVICE_TTL_MS);res.redirect(303,'/devices/me');
  });
  router.get('/me',requireDevice,(req,res)=>{
    const d=req.mpDevice;
    const history=listProgress.all(d.account_id,d.profile_id);
    page(res,`Aparelho: ${d.label}`,`<p>Perfil associado: <strong>${esc(d.profile_name)}</strong>.</p><p>Esta sessão é deste navegador. Outros aparelhos não serão alterados.</p>
      <h2>Histórico deste perfil</h2>${history.length?`<ol>${history.map(h=>`<li>${esc(h.title)} — ${h.durationMs<60000?Math.round(h.currentMs/1000)+' de '+Math.round(h.durationMs/1000)+' segundos':Math.round(h.currentMs/60000)+' de '+Math.round(h.durationMs/60000)+' minutos'}</li>`).join('')}</ol>`:'<p>Sem registros ainda.</p>'}
      <p><a href="/devices/player">Abrir player automático experimental</a> · <a href="/devices/bridge">Ativar ponte automática de rede</a></p>
      <h2>Atualização manual de teste</h2><form method="post" action="/devices/update"><label>Tipo <select name="type"><option value="movie">Filme</option><option value="series">Série</option></select></label><label>ID IMDb <input name="mediaId" placeholder="tt0133093" required></label><label>Nome <input name="title" maxlength="120" required></label><label>Minuto atual <input name="minutes" type="number" min="0" required></label><label>Duração em minutos <input name="duration" type="number" min="1" required></label><button>Salvar teste</button></form>
      <p>Para progresso automático, um player compatível precisa chamar <code>POST /devices/progress</code> deste mesmo navegador. O player nativo do Stremio não fornece este vínculo.</p><form method="post" action="/devices/unpair"><button>Desvincular este navegador</button></form>`);
  });
  // MULTIDEVICE_PLAYER_V02: player web opcional; exige cookie de dispositivo pareado.
  router.get('/player',requireDevice,(req,res)=> {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; media-src https: blob:; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    page(res,'Player automático · MultiDevice',renderDevicePlayer(req.mpDevice));
  });
  router.get('/player-client.js',requireDevice,(req,res)=> {
    res.set('Cache-Control','no-store').type('application/javascript').sendFile(fileURLToPath(new URL('./device-player-client.js',import.meta.url)));
  });
  router.get('/history.json',requireDevice,(req,res)=>res.set('Cache-Control','no-store').json({profile:req.mpDevice.profile_name,items:listProgress.all(req.mpDevice.account_id,req.mpDevice.profile_id)}));
  const write = (req, data) => {
    const item=validProgress(data);if(!item)return false;
    const d=req.mpDevice;
    updateProgress.run({account_id:d.account_id,profile_id:d.profile_id,video_id:item.videoId,media_id:item.mediaId,type:item.type,title:item.title,current_ms:item.currentMs,duration_ms:item.durationMs,action:item.action,device_id:d.id,updated_at:Date.now()});
    return true;
  };
  router.post('/update',requireDevice,originOkay,(req,res)=>{
    const b=req.body||{};
    const okay=write(req,{type:b.type,mediaId:b.mediaId,title:b.title,minutes:b.minutes,videoId:b.mediaId,currentMs:Number(b.minutes)*60_000,durationMs:Number(b.duration)*60_000,action:'pause'});
    if(!okay)return res.status(400).send('Dados inválidos');res.redirect(303,'/devices/me');
  });
  router.post('/progress',express.json({limit:'8kb'}),requireDevice,originOkay,(req,res)=> {
    if(req.get('x-device-client')!=='1')return res.status(403).json({error:'Cabeçalho do cliente obrigatório'});
    if(!write(req,req.body))return res.status(400).json({error:'Evento inválido'});
    res.set('Cache-Control','no-store').json({ok:true,profileId:req.mpDevice.profile_id});
  });
  router.post('/unpair',requireDevice,originOkay,(req,res)=> {
    revokeToken.run(Date.now(),req.mpDevice.id);setCookie(res,'',0);res.redirect(303,'/devices/activate');
  });
  return router;
}
