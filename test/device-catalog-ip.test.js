import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createCatalogIpResolver } from '../src/web/device-catalog-ip.js';

const PUBLIC_URL = 'https://profiles.example.com';

function request(peer, headers = {}) {
  return { socket: { remoteAddress: peer }, headers, get: name => headers[name] };
}

test('catalog network resolution trusts socket addresses and walks only configured proxy hops', () => {
  const resolve = createCatalogIpResolver({ publicUrl: PUBLIC_URL, trustProxy: 'loopback, 10.42.0.0/24' });
  assert.equal(resolve(request('8.8.8.8', { 'x-forwarded-for': '1.1.1.1' })), '8.8.8.8');
  assert.equal(resolve(request('2606:4700:4700::1111')), '2606:4700:4700::1111');
  assert.equal(resolve(request('10.42.0.5', { 'x-forwarded-for': '1.1.1.1, 8.8.8.8, 10.42.0.9' })), '8.8.8.8');
  assert.equal(resolve(request('::ffff:10.42.0.5', { 'x-forwarded-for': '8.8.8.8' })), '8.8.8.8');
  assert.equal(resolve(request('10.42.0.5', { 'x-forwarded-for': '8.8.8.8, 10.99.0.1' })), null);
  assert.equal(resolve(request('10.42.0.5', { 'x-forwarded-for': '10.42.0.9' })), null);
  assert.equal(resolve(request('10.99.0.1', { 'x-forwarded-for': '8.8.8.8' })), null);
  assert.equal(resolve(request('127.0.0.1', { 'x-real-ip': '1.1.1.1' })), null);
  for (const ip of [undefined, '192.168.0.1', '100.100.0.1', 'fe80::1', 'fd00::1', 'ff02::1', '2001:0db8::1']) {
    assert.equal(resolve(request(ip)), null);
  }
});

test('global proxy trust, hop counts and broad private aliases do not authorize forwarded IPs', () => {
  for (const trustProxy of [true, 1, 'true', '1', 'uniquelocal', '0.0.0.0/0', '::/0']) {
    const resolve = createCatalogIpResolver({ publicUrl: PUBLIC_URL, trustProxy });
    assert.equal(resolve(request('10.2.3.4', { 'x-forwarded-for': '8.8.8.8' })), null);
    assert.equal(resolve(request('8.8.8.8', { 'x-forwarded-for': '1.1.1.1' })), '8.8.8.8');
  }
});

test('Railway uses the public address header only within the explicitly isolated ingress configuration', () => {
  const headers = {
    host: 'profiles.example.com',
    'x-forwarded-host': 'profiles.example.com',
    'x-forwarded-proto': 'https',
    'x-railway-edge': 'test-edge',
    'x-real-ip': '2606:4700:4700::1111',
  };
  const ordinary = loadConfig({ PUBLIC_URL });
  assert.equal(ordinary.catalogRailwayEdgeOnly, false);
  assert.equal(createCatalogIpResolver(ordinary)(request('100.64.0.2', headers)), null);
  const isolated = loadConfig({ PUBLIC_URL, MULTIDEVICE_CATALOG_RAILWAY_EDGE_ONLY: 'true' });
  const resolve = createCatalogIpResolver(isolated);
  assert.equal(resolve(request('100.64.0.2', headers)), '2606:4700:4700::1111');
  assert.equal(resolve(request('100.64.0.2', { ...headers, 'x-forwarded-for': '8.8.8.8' })), '2606:4700:4700::1111');
  for (const override of [
    { 'x-railway-edge': '' }, { 'x-forwarded-proto': 'http' }, { host: 'internal.example.com' },
    { 'x-forwarded-host': 'other.example.com' }, { 'x-real-ip': '10.2.3.4' }, { 'x-real-ip': '1.1.1.1, 8.8.8.8' },
    { 'x-real-ip': undefined, 'x-forwarded-for': '8.8.8.8' },
  ]) {
    assert.equal(resolve(request('100.64.0.2', { ...headers, ...override })), null);
  }
  assert.equal(resolve(request('8.8.8.8', headers)), null);
});
