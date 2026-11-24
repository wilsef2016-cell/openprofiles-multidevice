import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDevicePlayer } from '../src/web/device-player-page.js';

test('a página do player escapa nomes recebidos do banco', () => {
  const html = renderDevicePlayer({ label: '<img onerror=alert(1)>', profile_name: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});
test('o formulário tem os IDs exigidos pelo player e não injeta URL no HTML', () => {
  const html = renderDevicePlayer({ label: 'Celular', profile_name: 'Original' });
  for (const id of ['player-form','paired-video','media-type','media-id','video-id','video-title','stream-url','player-status']) {
    assert.ok(html.includes(`id="${id}"`), `Faltou ${id}`);
  }
  assert.match(html, /src="\/devices\/player-client.js"/);
});
