#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const check = process.argv.includes('--check');
const root = process.cwd();
const file = path.join(root,'src/web/device-pairing.js');
for (const f of ['src/web/device-tracking.js','src/web/device-tracking-core.js']) {
  if (!fs.existsSync(path.join(root,f))) throw Error(`Arquivo ausente: ${f}`);
}
let source = fs.readFileSync(file,'utf8');
if (source.includes('MULTIDEVICE_TRACKING_V03')) {
  console.log('Integração Tracking já aplicada.');process.exit(0);
}
const anchors = [
  ["import crypto from 'node:crypto';", "import crypto from 'node:crypto';\nimport { createNativeTrackingRouter } from './device-tracking.js';"],
  ["  router.get('/',auth.require", "  // MULTIDEVICE_TRACKING_V03: eventos nativos SEM atribuição a aparelho/perfil.\n  router.use('/tracking', createNativeTrackingRouter({ db, auth, config, originOkay, page }));\n  router.get('/',auth.require"],
  ["      <h2>Aparelhos ativos</h2>", "      <p><a href=\"/devices/tracking\">Rastreamento nativo experimental (sem perfil atribuído)</a></p>\n      <h2>Aparelhos ativos</h2>"],
];
for (const [oldText,newText] of anchors) {
  const count = source.split(oldText).length-1;
  if (count !== 1) throw Error(`Arquivo mudou; âncora ambígua/ausente: ${oldText.slice(0,70)} (${count}). Nenhuma alteração escrita.`);
  source = source.replace(oldText,newText);
}
if (check) console.log('Patch compatível. Nenhuma modificação feita.');
else {fs.writeFileSync(file,source);console.log('Tracking nativo montado em /devices/tracking; dados de perfil preservados.');}
