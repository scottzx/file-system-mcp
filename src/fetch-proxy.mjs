import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';

const blocked4 = new net.BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(address, bits, 'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new net.BlockList();
for (const [address, bits] of [['2001:db8::', 32], ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28], ['2002::', 16]]) blocked6.addSubnet(address, bits, 'ipv6');
const fake4 = new net.BlockList(); fake4.addSubnet('198.18.0.0', 15, 'ipv4');
const fake6 = new net.BlockList(); fake6.addSubnet('2001:2::', 48, 'ipv6');
const dnsCache = new Map();

export function isPublicAddress(address) {
  const type = net.isIP(address);
  return type === 4 ? !blocked4.check(address, 'ipv4')
    : type === 6 && global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
}

async function dohAddresses(host) {
  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.addresses;
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', host); url.searchParams.set('type', 'A');
  const response = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error('Public DNS lookup failed.');
  const body = await response.json();
  if (body.Status !== 0 || body.TC) throw new Error('Public DNS lookup failed.');
  const answers = (body.Answer ?? []).filter((answer) => answer.type === 1);
  const addresses = answers.map((answer) => ({ address: answer.data, family: 4 }));
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Public DNS did not return public addresses.');
  const ttl = Math.max(0, Math.min(60, ...answers.map((answer) => Number(answer.TTL) || 0)));
  if (dnsCache.size >= 256) dnsCache.delete(dnsCache.keys().next().value);
  dnsCache.set(host, { addresses, expires: Date.now() + ttl * 1000 });
  return addresses;
}

export async function publicTarget(hostname, { lookup = dns.lookup, doh = dohAddresses } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true });
  const onlyFake = addresses.length && addresses.every(({ address }) => net.isIP(address) === 4 ? fake4.check(address, 'ipv4') : fake6.check(address, 'ipv6'));
  if (!net.isIP(host) && onlyFake && host.includes('.') && !/\.(local|localhost|internal|invalid|test)\.?$/i.test(host)) {
    // Proxy DNS can return benchmark-range Fake-IPs for public websites. Obtain
    // real public IPs over authenticated DoH; never connect to the Fake-IP itself.
    addresses = await doh(host);
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Fetch only permits public internet addresses.');
  // Connect to the validated IP directly, preventing a second DNS lookup/rebind.
  return addresses.find(({ family }) => family === 4) ?? addresses[0];
}

export function validateFetchUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) throw new Error('Fetch accepts public HTTP/HTTPS URLs on ports 80/443 without embedded credentials.');
  return url;
}

// The official Python server sends every request through this loopback proxy,
// including robots.txt and redirects. HTTPS remains end-to-end TLS.
export async function startFetchProxy() {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let outgoing;
    try {
      if (!['GET', 'HEAD'].includes(req.method) || req.headers.origin) throw new Error('Only server-side GET/HEAD requests are accepted.');
      const url = validateFetchUrl(req.url);
      if (url.protocol !== 'http:') throw new Error('HTTPS must use CONNECT.');
      const target = await publicTarget(url.hostname);
      outgoing = http.request({
        host: target.address, family: target.family, port: 80,
        method: req.method, path: url.pathname + url.search,
        headers: { host: url.host, 'user-agent': req.headers['user-agent'] ?? 'DreamMate-MCP-Fetch', accept: req.headers.accept ?? '*/*' },
      }, (response) => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('Fetch timed out.')));
      outgoing.on('error', (error) => { if (!res.headersSent) { res.writeHead(502); res.end(error.message); } else res.destroy(); });
      res.on('close', () => outgoing.destroy()); outgoing.end();
    } catch (error) { if (!res.headersSent) { res.writeHead(403); res.end(error.message); } }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    try {
      const url = validateFetchUrl('https://' + req.url);
      const target = await publicTarget(url.hostname);
      if (client.destroyed) return;
      const remote = net.connect({ host: target.address, family: target.family, port: 443 });
      sockets.add(remote); remote.on('close', () => sockets.delete(remote));
      remote.setTimeout(10_000, () => remote.destroy(new Error('Fetch timed out.')));
      remote.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        client.pipe(remote); remote.pipe(client);
      });
      remote.on('error', () => client.destroy()); client.on('close', () => remote.destroy());
    } catch (error) { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n' + error.message); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let closing;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (!closing) {
        for (const socket of sockets) socket.destroy();
        closing = new Promise((resolve) => server.close(resolve));
      }
      return closing;
    },
  };
}
