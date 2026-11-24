import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const kit=path.resolve(here,'..');
const target=path.resolve(process.argv[2]||'.');
const dryRun=process.argv.includes('--check');
const files={
  'src/web/app.js':[
    ["import { createAuth, wantsJson } from './auth.js';", "import { createAuth, wantsJson } from './auth.js';\nimport { createDevicePairingRouter } from './device-pairing.js';"],
    ['  app.use(createAddonRouter({ config, accounts, log, settings }));', "  app.use(createAddonRouter({ config, accounts, log, settings }));\n  if (process.env.MULTIDEVICE_MODE === 'true') app.use('/devices', createDevicePairingRouter({ db, auth, config }));"]
  ],
  'src/core/service.js':[
    ["  async doSwitch(profileId, { passcode = null, via = 'web' } = {}) {\n    const account = this.requireAccount();", "  async doSwitch(profileId, { passcode = null, via = 'web' } = {}) {\n    if (process.env.MULTIDEVICE_MODE === 'true') throw new UserError('MULTIDEVICE', 'Troca global desativada: pareie um aparelho em /devices.');\n    const account = this.requireAccount();"],
    ['      if (switchNow) {\n        try {', "      if (switchNow && process.env.MULTIDEVICE_MODE !== 'true') {\n        try {"]
  ],
  'src/addon/routes.js':[
    ['    const work = service.switchTo(id);', "    if (process.env.MULTIDEVICE_MODE === 'true') {\n      const link = `${publicUrl}/devices/activate`;\n      return res.json({ streams: [{ name: 'MultiDevice', description: 'Pareie este aparelho no navegador. Nao muda o perfil global do Stremio.', externalUrl: link, androidTvUrl: link }] });\n    }\n    const work = service.switchTo(id);"],
    ['p.id === state.active_profile_id', "p.id === state.active_profile_id && process.env.MULTIDEVICE_MODE !== 'true'"]
  ]
};
const modifications=[];
for(const [filename, rules] of Object.entries(files)) {
  const src=path.join(target,filename);
  if(!fs.existsSync(src))throw Error(`Arquivo não encontrado: ${src}. Use o código-fonte original, não apenas o Dockerfile do kit.`);
  const initial=fs.readFileSync(src,'utf8');let text=initial;
  for(const [from,to] of rules){
    const found=text.split(from).length-1;
    const already=text.includes(to);
    if(already)continue;
    if(found===0)throw Error(`Versão do OpenProfiles mudou; âncora ausente em ${filename}: ${from.slice(0,90)}`);
    // One replacement intentionally applies twice in addon/routes.js (catalog and meta).
    if(found>1 && filename==='src/addon/routes.js' && from==='p.id === state.active_profile_id') text=text.replaceAll(from,to);
    else if(found===1)text=text.replace(from,to);
    else throw Error(`Âncora ambígua em ${filename} (${found} ocorrências)`);
  }
  modifications.push({filename,src,initial,text});
}
if (dryRun) {
  console.log(`OK: patch compatível com ${target}. Nenhum arquivo alterado.`);
  process.exit(0);
}
const backup=path.join(target,'.multidevice-backup');
fs.mkdirSync(backup,{recursive:true});
for(const change of modifications){
  if(change.text===change.initial)continue;
  const dest=path.join(backup,change.filename.replaceAll('/','__'));
  if(!fs.existsSync(dest))fs.writeFileSync(dest,change.initial);
  fs.writeFileSync(change.src,change.text);
  console.log('Alterado:',change.filename);
}
for(const file of ['device-core.js','device-pairing.js']){
  const src=path.join(kit,'src','web',file);const dest=path.join(target,'src','web',file);
  fs.copyFileSync(src,dest);
  console.log('Criado:',`src/web/${file}`);
}
console.log('\nIntegração aplicada. Defina MULTIDEVICE_MODE=true no ambiente do NOVO servidor de teste.');
console.log('ATENÇÃO: não migre o volume de dados antigo sem backup; ainda não há histórico nativo independente.');
