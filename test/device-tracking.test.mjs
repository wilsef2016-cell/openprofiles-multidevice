import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeManifest,newToken,validToken,parseNativeEvent,digestToken} from '../src/web/device-tracking-core.js';
test('token has enough entropy and hashed storage',()=> {
  const a=newToken(),b=newToken();assert.ok(validToken(a));assert.notEqual(a,b);assert.notEqual(a,digestToken(a));
  assert.equal(validToken('12345678'),false);
});
test('manifest exposes only player resource, no catalogs or device identity',()=> {
  const manifest=nativeManifest(newToken());assert.equal(manifest.resources[0].name,'player');
  assert.deepEqual(manifest.catalogs,[]);assert.deepEqual(manifest.types,['movie','series']);
});
test('parses official player start/pause/stop events in milliseconds',()=> {
  const params='action=pause&currentTime=3000&duration=60000';
  assert.deepEqual(parseNativeEvent('movie','tt1254207',params), {type:'movie',videoId:'tt1254207',action:'pause',currentMs:3000,durationMs:60000});
  assert.equal(parseNativeEvent('series','tt0898266:9:17','action=stop&currentTime=3000&duration=60000')?.videoId,'tt0898266:9:17');
});
test('rejects malformed and duplicate events and unexpected types',()=> {
  for(const extra of ['action=jump&currentTime=1&duration=100','action=pause&currentTime=-1&duration=100','action=pause&currentTime=100&duration=0','action=pause&currentTime=999999&duration=100','action=start&action=stop&currentTime=1&duration=100','action=start&currentTime=abc&duration=100']) {
    assert.equal(parseNativeEvent('movie','tt1254207',extra),null,extra);
  }
  assert.equal(parseNativeEvent('movie','../secret','action=start&currentTime=1&duration=100'),null);
  assert.equal(parseNativeEvent('other','tt1254207','action=start&currentTime=1&duration=100'),null);
});
