#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// Rodar na raiz do fork. --check verifica sem escrever.
const target = process.cwd();
const check = process.argv.includes('--check');
const file = path.join(target, 'src/web/device-pairing.js');
if (!fs.existsSync(file)) throw new Error('src/web/device-pairing.js não encontrado: execute na raiz do fork correto.');
for (const relative of ['src/web/device-player-page.js', 'src/web/device-player-client.js']) {
  if (!fs.existsSync(path.join(target, relative))) throw new Error(`Arquivo obrigatório ausente: ${relative}`);
}
let source = fs.readFileSync(file, 'utf8');
const already = source.includes('MULTIDEVICE_PLAYER_V02');
if (!already) {
  const imports = "import crypto from 'node:crypto';";
  const history = "  router.get('/history.json',requireDevice";
  const form = '      <h2>Atualização manual de teste</h2>';
  const oldDuration = '${Math.round(h.currentMs/60000)} de ${Math.round(h.durationMs/60000)} minutos';
  for (const [label, str] of [['imports',imports],['history',history],['form',form],['duration',oldDuration]]) {
    const count = source.split(str).length - 1;
    if (count !== 1) throw new Error(`O código mudou: âncora ${label} encontrada ${count} vezes; não alterei nada.`);
  }
  source = source.replace(imports,
    imports + "\nimport { fileURLToPath } from 'node:url';\nimport { renderDevicePlayer } from './device-player-page.js';");
  const routes = `  // MULTIDEVICE_PLAYER_V02: player web opcional; exige cookie de dispositivo pareado.\n` +
`  router.get('/player',requireDevice,(req,res)=> {\n` +
`    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; media-src https: blob:; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");\n` +
`    page(res,'Player automático · MultiDevice',renderDevicePlayer(req.mpDevice));\n` +
`  });\n` +
`  router.get('/player-client.js',requireDevice,(req,res)=> {\n` +
`    res.set('Cache-Control','no-store').type('application/javascript').sendFile(fileURLToPath(new URL('./device-player-client.js',import.meta.url)));\n` +
`  });\n`;
  source = source.replace(history, routes + history);
  source = source.replace(form, '      <p><a href="/devices/player">Abrir player automático experimental</a></p>\n' + form);
  source = source.replace(oldDuration, "${h.durationMs<60000?Math.round(h.currentMs/1000)+' de '+Math.round(h.durationMs/1000)+' segundos':Math.round(h.currentMs/60000)+' de '+Math.round(h.durationMs/60000)+' minutos'}");
}
if (check) console.log(already ? 'Player já aplicado.' : 'Âncoras verificadas, patch compatível. Nenhum arquivo alterado.');
else if (already) console.log('Player já aplicado; nenhuma alteração necessária.');
else { fs.writeFileSync(file,source); console.log('Player instalado: /devices/player, preservando as rotas existentes.'); }
