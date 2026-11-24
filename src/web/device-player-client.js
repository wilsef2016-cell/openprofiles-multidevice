/* global document, window */
/* Player web experimental, executado somente no navegador já pareado. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('player-form');
  const video = $('paired-video');
  const status = $('player-status');
  const positionLabel = $('saved-position');
  const typeInput = $('media-type');
  const mediaInput = $('media-id');
  const episodeInput = $('video-id');
  const titleInput = $('video-title');
  const sourceInput = $('stream-url');
  let active = null;
  let lastPeriodicAt = 0;
  let sequence = Promise.resolve();
  let pendingResumeMs = 0;

  function setStatus(message) { status.textContent = message; }
  function formatTime(seconds) {
    const safe = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(safe / 60)}m ${String(safe % 60).padStart(2, '0')}s`;
  }
  function directHttpsUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  function currentPayload(action) {
    if (!active || !Number.isFinite(video.duration) || video.duration <= 0) return null;
    return {
      profileId: form.dataset.profileId,
      type: active.type,
      mediaId: active.mediaId,
      videoId: active.videoId,
      title: active.title,
      currentMs: Math.round(Math.min(Math.max(0, video.currentTime), video.duration) * 1000),
      durationMs: Math.round(video.duration * 1000),
      action,
    };
  }
  function send(action, keepalive = false) {
    const payload = currentPayload(action);
    if (!payload) return;
    // Serializa requisições para evitar que um evento antigo sobrescreva o último minuto.
    sequence = sequence.catch(() => {}).then(async () => {
      const response = await fetch('/devices/progress', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Device-Client': '1' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        keepalive,
      });
      if (response.status === 409) throw new Error('O perfil deste aparelho mudou. Recarregue a página.');
      if (!response.ok) throw new Error(`Servidor retornou ${response.status}. Verifique o pareamento.`);
      if (!keepalive) setStatus(`Progresso salvo: ${formatTime(payload.currentMs / 1000)} (${action}).`);
    }).catch((error) => {
      if (!keepalive) setStatus(`Não foi possível salvar o progresso: ${error.message}`);
    });
  }
  async function savedFor(videoId) {
    const query = new URLSearchParams({ profileId: form.dataset.profileId });
    const response = await fetch(`/devices/history.json?${query}`, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 409) throw new Error('O perfil deste aparelho mudou. Recarregue a página.');
    if (!response.ok) throw new Error('Sessão de aparelho inválida. Abra /devices/activate.');
    const history = await response.json();
    return (history.items || []).find((entry) => entry.videoId === videoId) || null;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const type = typeInput.value;
    const mediaId = mediaInput.value.trim();
    const episode = episodeInput.value.trim();
    const videoId = episode || mediaId;
    const title = titleInput.value.trim();
    const source = directHttpsUrl(sourceInput.value.trim());
    if (!/^tt\d{5,12}$/.test(mediaId) || !/^[A-Za-z0-9:_-]{3,120}$/.test(videoId) || !title || !source) {
      setStatus('Confira o ID IMDb, o nome, o ID do vídeo e o link HTTPS.');
      return;
    }
    if (type === 'series' && !episode) {
      setStatus('Para séries, preencha um ID de episódio diferente para cada episódio (ex.: tt1234567:1:1).');
      return;
    }
    try {
      setStatus('Consultando o histórico deste perfil...');
      const saved = await savedFor(videoId);
      video.pause();
      active = { type, mediaId, videoId, title };
      pendingResumeMs = saved && saved.action !== 'ended' ? Math.max(0, Number(saved.currentMs) || 0) : 0;
      positionLabel.textContent = saved
        ? `Progresso anterior neste perfil: ${formatTime(saved.currentMs / 1000)}.`
        : 'Nenhum progresso anterior para este vídeo.';
      lastPeriodicAt = 0;
      video.removeAttribute('src');
      video.load();
      video.src = source;
      video.load();
      setStatus('Vídeo carregando. Use Reproduzir para começar.');
    } catch (error) {
      setStatus(`Falha ao carregar o progresso: ${error.message}`);
    }
  });

  video.addEventListener('loadedmetadata', () => {
    if (!active) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      setStatus('Este player só registra vídeos com duração conhecida.');
      return;
    }
    if (pendingResumeMs > 0) {
      const seconds = Math.min(pendingResumeMs / 1000, Math.max(0, video.duration - 0.25));
      try { video.currentTime = seconds; } catch { /* Alguns formatos não aceitam seek. */ }
      setStatus(`Progresso recuperado: ${formatTime(seconds)}. Pressione Reproduzir.`);
    } else {
      setStatus(`Vídeo pronto: ${formatTime(video.duration)}. Pressione Reproduzir.`);
    }
    pendingResumeMs = 0;
  });
  video.addEventListener('playing', () => { lastPeriodicAt = Date.now(); send('start'); });
  video.addEventListener('timeupdate', () => {
    if (!active || video.paused || video.ended || !Number.isFinite(video.duration)) return;
    if (Date.now() - lastPeriodicAt >= 15000) {
      lastPeriodicAt = Date.now();
      send('start');
    }
  });
  video.addEventListener('pause', () => {
    if (active && !video.ended) send('pause');
  });
  video.addEventListener('seeked', () => {
    if (active && !video.ended) send('pause');
  });
  video.addEventListener('ended', () => send('ended'));
  video.addEventListener('error', () => {
    setStatus('Não foi possível reproduzir o vídeo. Confira o link, o formato e as permissões do servidor de mídia.');
  });
  window.addEventListener('pagehide', () => {
    if (active && !video.ended) send('stop', true);
  });
})();
