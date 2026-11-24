import test from 'node:test';
import assert from 'node:assert/strict';
import {publicIp, networkDigest, candidateForNetwork, NETWORK_TTL_MS} from '../src/web/device-bridge-core.js';

test('IP público válido e IPs de proxy/LAN rejeitados', () => {
  assert.equal(publicIp('::ffff:8.8.8.8'),'8.8.8.8');
  for (const ip of ['127.0.0.1','10.0.0.2','192.168.1.2','172.20.1.4','100.64.1.2','::1','fe80::1','not an ip'])
    assert.equal(publicIp(ip),null,ip);
  assert.equal(publicIp('1.1.1.1'),'1.1.1.1');
});
test('HMAC consistente, não armazena o IP em texto', () => {
  const secret='test-secret-different-on-every-install';
  assert.equal(networkDigest(secret,'8.8.8.8'),networkDigest(secret,'::ffff:8.8.8.8'));
  assert.notEqual(networkDigest(secret,'8.8.8.8'),networkDigest(secret,'1.1.1.1'));
  assert.equal(networkDigest(secret,'127.0.0.1'),null);
  assert.ok(!networkDigest(secret,'8.8.8.8').includes('8.8.8.8'));
});
test('Correspondência é só candidata e nunca escolhe entre dispositivos na mesma rede', () => {
  const now=1_000_000;
  const bound=(id,hash='x')=>({device_id:id,ip_hash:hash,expires_at:now+NETWORK_TTL_MS,
    device_expires_at:now+NETWORK_TTL_MS,revoked_at:null});
  assert.equal(candidateForNetwork([bound('a')],'x',now).status,'possible');
  assert.equal(candidateForNetwork([bound('a'),bound('b')],'x',now).status,'ambiguous');
  assert.equal(candidateForNetwork([bound('a')],'y',now).status,'unmatched');
  assert.equal(candidateForNetwork([bound('a')],null,now).status,'unavailable');
  assert.equal(candidateForNetwork([{...bound('a'),revoked_at:now}],'x',now).status,'unmatched');
  assert.equal(candidateForNetwork([{...bound('a'),expires_at:now-1}],'x',now).status,'unmatched');
});
