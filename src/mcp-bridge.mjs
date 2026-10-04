import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';

export const VERSION = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
export function errorResult(error) {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
}

export class McpBridge {
  constructor({ prefix, transport, upstream, upstreamVersion, readOnly = false,
    timeoutMs = 12_000, log = () => {}, prepare = async () => {},
    prepareParams = async (_name, params) => params, toolFilter = () => true,
    serialize = false, metadata = {}, annotations = {} }) {
    Object.assign(this, { prefix, transport, upstream, upstreamVersion, readOnly, timeoutMs, log, prepare, prepareParams, toolFilter, serialize, metadata, annotations });
    this.tools = [];
    this.client = null;
    this.connecting = null;
    this.closed = false;
    this.queue = Promise.resolve();
  }
  get ready() { return this.client !== null; }
  async start() {
    if (this.closed) throw new Error('MCP bridge is closed.');
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try { await this.connecting; } finally { this.connecting = null; }
  }
  async connect() {
    await this.prepare();
    const client = new Client({ name: '@1agents/file-system-mcp', version: VERSION });
    const transport = new StdioClientTransport(typeof this.transport === 'function' ? this.transport() : this.transport);
    transport.stderr?.on('data', (chunk) => this.log(chunk.toString().trim()));
    client.onclose = () => { if (this.client === client) this.client = null; };
    client.onerror = (error) => this.log(`upstream: ${error.message}`);
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: this.timeoutMs });
        tools.push(...page.tools); cursor = page.nextCursor;
      } while (cursor);
      this.tools = tools.map((tool) => this.annotations[tool.name] ? { ...tool, annotations: { ...tool.annotations, ...this.annotations[tool.name] } } : tool)
        .filter((tool) => this.toolFilter(tool) && (!this.readOnly || tool.annotations?.readOnlyHint === true));
      if (!this.tools.length) throw new Error('Upstream returned no permitted tools.');
      this.client = client;
    } catch (error) { await client.close().catch(() => {}); throw error; }
  }
  get methods() { return toolMethods(this.prefix, this.tools); }
  async invoke(method, params = {}) {
    if (typeof method !== 'string') return errorResult('method is required.');
    if (!params || typeof params !== 'object' || Array.isArray(params)) return errorResult('params must be an object.');
    const call = async () => {
      try {
        await this.start();
        const name = method.startsWith(this.prefix) ? method.slice(this.prefix.length) : method;
        if (!this.tools.some((tool) => tool.name === name)) return errorResult(`Unknown or disabled method: ${method}`);
        const arguments_ = await this.prepareParams(name, params);
        return await this.client.callTool({ name, arguments: arguments_ }, undefined, { timeout: this.timeoutMs });
      } catch (error) { return errorResult(error); }
    };
    // Serialize mutable state (memory and git); never replay a failed operation.
    if (!this.serialize) return call();
    const result = this.queue.then(call);
    this.queue = result.catch(() => {});
    return result;
  }
  async close() {
    this.closed = true;
    await this.connecting?.catch(() => {});
    const client = this.client; this.client = null;
    await client?.close();
  }
}

export function toolMethods(prefix, tools) {
  return Object.fromEntries(tools.map((tool) => [prefix + tool.name, {
    description: tool.description || tool.name, parameters: tool.inputSchema,
    ...(tool.outputSchema ? { returns: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }]));
}

export class NamespacedBridge {
  constructor({ prefix, key, factory, metadata, limit = 8, idleMs = 300_000 }) {
    Object.assign(this, { prefix, key, factory, metadata, limit, idleMs });
    this.sessions = new Map(); this.tools = []; this.closed = false; this.started = false;
    this.connecting = null; this.timer = null;
  }
  get ready() { return this.started && !this.closed; }
  get methods() { return toolMethods(this.prefix, this.tools); }
  async start() {
    if (this.closed) throw new Error('MCP bridge is closed.');
    if (this.started) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const schema = await this.factory('_schema');
      try {
        await schema.start();
        this.upstream = schema.upstream; this.upstreamVersion = schema.upstreamVersion;
        this.tools = schema.tools.map((tool) => ({ ...tool, inputSchema: {
          ...tool.inputSchema,
          properties: { ...tool.inputSchema.properties, [this.key]: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$', description: this.key === 'namespace' ? 'Project memory namespace; data is isolated per namespace.' : 'Unique task/session id; thinking state is isolated per session.' } },
          required: [...(tool.inputSchema.required ?? []), this.key],
        } }));
        this.started = true;
        this.timer = setInterval(() => { void this.expire(); }, Math.min(this.idleMs, 60_000)); this.timer.unref();
      } finally { await schema.close(); }
    })();
    try { await this.connecting; } finally { this.connecting = null; }
  }
  async expire() {
    for (const [key, session] of this.sessions) {
      if (!session.active && Date.now() - session.usedAt >= this.idleMs) {
        this.sessions.delete(key); await session.bridge.close();
      }
    }
  }
  async invoke(method, params = {}) {
    try {
      await this.start();
      if (typeof method !== 'string' || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('method and object params are required.');
      const name = method.startsWith(this.prefix) ? method.slice(this.prefix.length) : method;
      if (!this.tools.some((tool) => tool.name === name)) throw new Error(`Unknown method: ${method}`);
      const key = params[this.key];
      if (typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(key)) throw new Error(`A valid ${this.key} is required.`);
      let session = this.sessions.get(key);
      if (!session) {
        await this.expire();
        session = this.sessions.get(key);
        if (!session) {
          if (this.sessions.size >= this.limit) throw new Error(`Session limit ${this.limit} reached; idle sessions expire after ${this.idleMs / 1000} seconds.`);
          session = { bridge: this.factory(key), usedAt: Date.now(), active: 0 };
          // Store the factory promise before awaiting it, preventing duplicate writers.
          this.sessions.set(key, session);
        }
      }
      session.active++; session.usedAt = Date.now();
      try {
        session.bridge = await session.bridge;
        const upstreamParams = { ...params }; delete upstreamParams[this.key];
        return await session.bridge.invoke(name, upstreamParams);
      } finally { session.active--; session.usedAt = Date.now(); }
    } catch (error) { return errorResult(error); }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await this.connecting?.catch(() => {});
    clearInterval(this.timer);
    await Promise.all([...this.sessions.values()].map(async (session) => (await session.bridge).close()));
    this.sessions.clear();
  }
}
