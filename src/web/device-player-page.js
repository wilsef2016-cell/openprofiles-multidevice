import { esc } from './device-core.js';

/** HTML devolvido apenas para navegadores com pareamento válido. */
export function renderDevicePlayer(device) {
  return `<p><a href="/devices/me">Voltar ao aparelho</a> · <a href="/devices/history.json">Histórico em JSON</a></p>
    <p><strong>Aparelho:</strong> ${esc(device.label)} · <strong>Perfil:</strong> ${esc(device.profile_name)}</p>
    <p>Este player experimental salva o progresso automaticamente no perfil pareado. Ele <strong>não é o player nativo do Stremio</strong>.</p>
    <form id="player-form" autocomplete="off">
      <p><label>Tipo <select id="media-type"><option value="movie">Filme</option><option value="series">Série</option></select></label></p>
      <p><label>ID IMDb da obra <input id="media-id" required placeholder="tt0133093" pattern="tt[0-9]{5,12}" maxlength="14"></label></p>
      <p><label>ID do vídeo/episódio <input id="video-id" placeholder="Opcional para filme; obrigatório para episódio" maxlength="120"></label></p>
      <p><label>Nome <input id="video-title" required maxlength="120" placeholder="Vídeo de teste"></label></p>
      <p><label>Link direto HTTPS MP4/WebM autorizado <input id="stream-url" type="url" inputmode="url" required placeholder="https://exemplo.com/video.mp4" style="width:min(100%,650px)"></label></p>
      <p><button type="submit">Carregar vídeo</button></p>
    </form>
    <p id="player-status" role="status" aria-live="polite">Informe um vídeo autorizado e clique em Carregar vídeo.</p>
    <video id="paired-video" controls playsinline preload="metadata" style="display:block;width:min(100%,780px);max-height:65vh;background:#111" aria-label="Player de teste"></video>
    <p id="saved-position"></p>
    <p><small>O link do vídeo não é salvo no nosso servidor. O navegador o carrega diretamente do endereço informado. O suporte ao formato depende do navegador e da origem do arquivo.</small></p>
    <script src="/devices/player-client.js" defer></script>`;
}
