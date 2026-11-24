#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const check = process.argv.includes('--check');
const root = process.cwd();
const pairingFile = path.join(root,'src/web/device-pairing.js');
const trackingFile = path.join(root,'src/web/device-tracking.js');
for (const f of [pairingFile, trackingFile, path.join(root,'src/web/device-network-bridge.js'), path.join(root,'src/web/device-bridge-core.js')]) {
  if (!fs.existsSync(f)) throw Error(`Arquivo ausente: ${f}`);
}
let pairing = fs.readFileSync(pairingFile,'utf8');
let tracking = fs.readFileSync(trackingFile,'utf8');
if (pairing.includes('MULTIDEVICE_NETWORK_BRIDGE_V04') && tracking.includes('MULTIDEVICE_NETWORK_BRIDGE_V04')) {
  console.log('v0.4 já instalada.');process.exit(0);
}
function replaceOnce(source,oldText,newText,where) {
  const count=source.split(oldText).length-1;
  if(count!==1) throw Error(`Falha segura: a âncora mudou em ${where} (${count} ocorrências): ${oldText.slice(0,90)}`);
  return source.replace(oldText,newText);
}
// Do all replacements in RAM; save neither file if an anchor is missing.
pairing=replaceOnce(pairing,
  "import { createNativeTrackingRouter } from './device-tracking.js';",
  "import { createNativeTrackingRouter } from './device-tracking.js';\nimport { createDeviceNetworkBridge } from './device-network-bridge.js';",pairingFile);
pairing=replaceOnce(pairing,
  "  router.use('/tracking', createNativeTrackingRouter({ db, auth, config, originOkay, page }));",
  "  // MULTIDEVICE_NETWORK_BRIDGE_V04: ponte por rede, nunca altera mp_progress.\n  let networkBridge;\n  router.use('/tracking', createNativeTrackingRouter({ db, auth, config, originOkay, page, resolveBridge: () => networkBridge }));\n  networkBridge = createDeviceNetworkBridge({ db, requireDevice, originOkay, page });\n  router.use('/bridge', networkBridge.router);",pairingFile);
pairing=replaceOnce(pairing,
  '<p><a href="/devices/tracking">Rastreamento nativo experimental (sem perfil atribuído)</a></p>',
  '<p><a href="/devices/tracking">Rastreamento nativo experimental (sem perfil atribuído)</a> · <a href="/devices/bridge">Associação automática por rede (experimental)</a></p>',pairingFile);
pairing=replaceOnce(pairing,
  '<p><a href="/devices/player">Abrir player automático experimental</a></p>',
  '<p><a href="/devices/player">Abrir player automático experimental</a> · <a href="/devices/bridge">Ativar ponte automática de rede</a></p>',pairingFile);
tracking=replaceOnce(tracking,
  'export function createNativeTrackingRouter({db, auth, config, originOkay, page}) {',
  'export function createNativeTrackingRouter({db, auth, config, originOkay, page, resolveBridge}) {',trackingFile);
tracking=replaceOnce(tracking,
  '    insertEvent.run(installation.account_id,installation.id,event.type,event.videoId,event.action,event.currentMs,event.durationMs,now);',
  `    const result = insertEvent.run(installation.account_id,installation.id,event.type,event.videoId,event.action,event.currentMs,event.durationMs,now);
    // MULTIDEVICE_NETWORK_BRIDGE_V04: somente candidato; nenhum progresso confirmado alterado.
    try {
      resolveBridge?.()?.suggest({req,accountId:installation.account_id,eventId:Number(result.lastInsertRowid),now});
    } catch (error) {
      console.error('[MultiDevice network diagnostic] Failed to record tentative candidate:',error?.message);
    }`,trackingFile);
if(check) console.log('Patch v0.4 compatível. Nenhuma modificação feita.');
else {
  fs.writeFileSync(pairingFile,pairing);
  fs.writeFileSync(trackingFile,tracking);
  console.log('Ponte automática v0.4 aplicada sem modificar históricos anteriores.');
}
