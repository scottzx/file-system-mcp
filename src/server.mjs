import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { VERSION, UPSTREAM_VERSION, errorResult } from './bridge.mjs';

export const DEFAULT_PORT = 7784;
export const DEFAULT_AGENT = 'http://127.0.0.1:36908';
const skillDir = fileURLToPath(new URL('../skills/file-system-mcp', import.meta.url));

export function localAgentUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--agent must be a local HTTP gateway, e.g. http://127.0.0.1:36908');
  }
  return url.origin;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req, limit) {
  const chunks = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const clean = () => { req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); };
    const fail = (error) => { clean(); reject(error); };
    const aborted = () => fail(Object.assign(new Error('Request aborted.'), { status: 400 }));
    const end = () => { clean(); resolve(chunks); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        clean(); req.resume();
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
      } else chunks.push(chunk);
    };
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
  });
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 }); }
}

async function requestAgent(agent, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(agent + pathname, {
    method,
    signal: AbortSignal.timeout(2_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  // Drain within the deadline; a headers-only response is not registration proof.
  const text = await response.text();
  if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export async function startServer(bridge, {
  port = DEFAULT_PORT, id = 'filesystem', agent = DEFAULT_AGENT,
  report = true, registrationIntervalMs = 30_000, bodyLimit = 8 * 1024 * 1024,
  profile = {},
  log = (message) => process.stderr.write(`[file-system-mcp] ${message}\n`),
} = {}) {
  agent = localAgentUrl(agent);
  await bridge.start();
  const selectedSkillDir = profile.skillDir ?? skillDir;
  const skillName = profile.skillName ?? 'file-system-mcp';
  const skillDescription = profile.skillDescription ?? '通过 DreamMate 能力网络读取、编辑和管理目标节点开放目录内的文件。';
  const skillRaw = await fs.readFile(`${selectedSkillDir}/SKILL.md`, 'utf8');
  const sop = skillRaw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  let closing = false;
  let timer;
  let registered = false;
  let lastRegistrationError = null;
  let reporting = null;
  let registration;
  let stopPromise;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) return json(res, 403, errorResult('Browser-originated requests are not accepted.'));
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === '/health') {
        return json(res, bridge.ready && !closing ? 200 : 503, {
          status: bridge.ready && !closing ? 'ok' : 'unavailable', service: id,
          version: VERSION, upstream_version: bridge.upstreamVersion ?? UPSTREAM_VERSION,
          allowed_directories: bridge.roots, read_only: bridge.readOnly,
          ...bridge.metadata,
          registered, registration_error: lastRegistrationError,
        });
      }
      if (req.method === 'GET' && pathname === '/manifest') return json(res, 200, registration);
      if (req.method === 'POST' && pathname === '/invoke') {
        if (closing) return json(res, 503, errorResult('Service is shutting down.'));
        const body = await readJson(req, bodyLimit);
        return json(res, 200, await bridge.invoke(body.method ?? body.capability, body.params ?? {}));
      }
      if (req.method === 'POST' && pathname === '/shutdown') {
        json(res, 200, { status: 'stopping' });
        void stop().catch((error) => log(`shutdown: ${error.message}`));
        return;
      }
      json(res, 404, errorResult('Unknown endpoint.'));
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status ?? 500, errorResult(error));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await bridge.close(); throw error; }
  const actualPort = server.address().port;
  registration = {
    id, name: profile.name ?? '文件系统 MCP', kind: 'mcp', execution: 'http',
    port: actualPort, reachability: 'localhost', health: '/health',
    methods: bridge.methods,
    skills: { [skillName]: {
      name: skillName, description: skillDescription,
      sop, source_dir: selectedSkillDir,
    } },
    lifecycle: { can_spawn: false, can_shutdown: true, stop_endpoint: '/shutdown' },
    metadata: {
      version: VERSION, upstream: bridge.upstream ?? '@modelcontextprotocol/server-filesystem', upstream_version: bridge.upstreamVersion ?? UPSTREAM_VERSION,
      allowed_directories: bridge.roots, read_only: bridge.readOnly,
      ...bridge.metadata,
    },
  };

  async function register() {
    if (closing || reporting) return reporting;
    reporting = (async () => {
      try {
        await bridge.start();
        registration.methods = bridge.methods;
        await requestAgent(agent, '/services', { method: 'POST', body: registration });
        if (!registered) log(`registered ${id} with ${agent}`);
        registered = true;
        lastRegistrationError = null;
      } catch (error) {
        if (lastRegistrationError !== error.message) log(`registration pending: ${error.message}`);
        registered = false;
        lastRegistrationError = error.message;
      }
    })();
    try { await reporting; } finally { reporting = null; }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      closing = true;
      clearInterval(timer);
      await reporting;
      if (report && registered) {
        // Do not unregister a replacement that now owns the same service id.
        try {
          const services = await requestAgent(agent, '/services');
          const entries = Array.isArray(services) ? services : services.services ?? [];
          if (entries.some((entry) => entry.id === id && entry.port === actualPort)) {
            await requestAgent(agent, `/services/${encodeURIComponent(id)}`, { method: 'DELETE' });
          }
        } catch { /* Gateway health checks eventually remove stale registrations. */ }
      }
      await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });
      await bridge.close();
    })();
    return stopPromise;
  }

  if (report) {
    await register();
    timer = setInterval(() => { void register(); }, registrationIntervalMs);
    timer.unref();
  }
  return { server, port: actualPort, registration, stop, register };
}
