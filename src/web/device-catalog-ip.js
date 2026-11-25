import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';
import { publicIp } from './device-bridge-core.js';

const internalPeer = proxyaddr.compile(['loopback', 'linklocal', 'uniquelocal', '100.64.0.0/10']);
const documentationIp = proxyaddr.compile(['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '2001:db8::/32', '3fff::/20']);
const globalV6 = proxyaddr.compile('2000::/3');

function catalogPublicIp(value) {
  const ip = publicIp(value);
  if (!ip || ip.includes('%') || documentationIp(ip) || (isIP(ip) === 6 && !globalV6(ip))) return null;
  return ip;
}

function trustedProxyRange(entry) {
  if (entry === 'loopback') return true;
  const [ip, prefix, extra] = entry.split('/');
  const version = isIP(ip);
  if (!version || extra !== undefined) return false;
  return prefix === undefined || (/^[1-9]\d*$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128));
}

export function createCatalogIpResolver(config) {
  // The Express defaults also trust private networks for general app requests.
  // Catalogs accept loopback and explicitly listed addresses or CIDRs only.
  const entries = typeof config.trustProxy === 'string' ? config.trustProxy.split(',') : config.trustProxy;
  const trusted = Array.isArray(entries) ? entries.filter(entry => typeof entry === 'string').map(entry => entry.trim()) : [];
  const trust = proxyaddr.compile(trusted.filter(trustedProxyRange));
  const url = new URL(config.publicUrl);

  return req => {
    const peer = req.socket.remoteAddress;
    if (!isIP(peer)) return null;

    // Railway does not authenticate these headers to the app. The operator may
    // opt in only after verifying that the public edge is the sole ingress.
    if (config.catalogRailwayEdgeOnly === true) {
      const sameHost = req.get('host') === url.host && req.get('x-forwarded-host') === url.host;
      if (url.protocol !== 'https:' || !sameHost || req.get('x-forwarded-proto') !== 'https' ||
          !req.get('x-railway-edge') || !internalPeer(peer)) return null;
      return catalogPublicIp(req.get('x-real-ip'));
    }

    if (!trust(peer)) return catalogPublicIp(peer);
    // Start at the socket and walk right-to-left only across configured
    // proxies. If there's no client address, fail closed.
    const client = proxyaddr(req, trust);
    return trust(client) ? null : catalogPublicIp(client);
  };
}
