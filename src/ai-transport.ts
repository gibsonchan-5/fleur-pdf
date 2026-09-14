/**
 * AI 请求通道 —— 免 CORS 的 Node 通道与系统代理探测
 *
 * 为什么需要这个模块：
 * Obsidian 渲染进程的 origin 是 `app://obsidian.md`，插件里的原生 fetch 是浏览器请求，
 * 受同源策略约束。官方 OpenAI 与 Anthropic 的 POST 响应**不返回** Access-Control-Allow-Origin，
 * 浏览器据此判定跨域失败，fetch 直接抛 `TypeError: Failed to fetch`——请求其实已经打到服务端了。
 * 换到 Node 通道（http/https/net/tls）就绕开了浏览器同源策略，且依然支持 SSE 逐块流式。
 *
 * 设计约束（与「国内用户零影响」直接相关）：
 * 1. 本通道**只作为回退**，fetch 成功时一行都不执行。
 * 2. 所有 Node 能力都做「探测式加载」：环境不满足时 isNodeTransportAvailable() 返回 false，
 *    调用方直接跳过，不会影响原有行为。
 * 3. 不引入任何第三方依赖，只用 Node 内置模块。
 */

type AnyRecord = Record<string, any>;
type AnyFn = (...args: any[]) => any;

/** 单次尝试的「连接 + 响应头」超时。响应头一到就解除，不影响后续流式的长时间输出。 */
export const NODE_CONNECT_TIMEOUT_MS = 12000;

export type TransportFailureKind = 'network' | 'abort';

/** 通道层的失败。network 表示链路失败（可换通道重试），abort 表示用户主动中止。 */
export class TransportError extends Error {
  readonly kind: TransportFailureKind;

  constructor(kind: TransportFailureKind, message: string) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

function getGlobal(): AnyRecord {
  return globalThis as unknown as AnyRecord;
}

/**
 * 安全获取 Node 内置模块。渲染进程在无 Node 集成的环境下会返回 null，
 * 而不是让插件在加载期就崩掉。
 */
export function loadNodeModule(name: string): AnyRecord | null {
  try {
    const reqCandidate = typeof require === 'function'
      ? (require as unknown)
      : getGlobal().require;
    if (typeof reqCandidate !== 'function') return null;
    const mod = (reqCandidate as AnyFn)(name);
    return mod && (typeof mod === 'object' || typeof mod === 'function') ? (mod as AnyRecord) : null;
  } catch {
    return null;
  }
}

let nodeAvailable: boolean | null = null;

/** Node 通道是否可用（探测一次并缓存）。不可用时调用方应保持原有行为。 */
export function isNodeTransportAvailable(): boolean {
  if (nodeAvailable === null) {
    nodeAvailable = !!(loadNodeModule('http') && loadNodeModule('https') && loadNodeModule('net') && loadNodeModule('tls'));
  }
  return nodeAvailable;
}

// ─────────────────────────────────────────────────────────────
// 端点归一化
// ─────────────────────────────────────────────────────────────

/**
 * 把设置里的 Base URL 归一化成完整的 chat/completions 地址。
 *
 * 处理三种常见填法：结尾多余斜杠、漏写协议头、误填完整端点。
 * 返回 null 表示配置不可用（**绝不**静默替换成别的服务商，避免把密钥发到非预期的主机）。
 */
export function resolveChatEndpoint(baseUrl: string): string | null {
  const raw = (baseUrl ?? '').trim();
  if (!raw || raw.startsWith('/')) return null;

  let url = raw.replace(/\/+$/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  if (/\/chat\/completions$/i.test(url)) return url;
  return `${url}/chat/completions`;
}

// ─────────────────────────────────────────────────────────────
// SSE 解析（fetch 通道与 Node 通道共用，保证两条链路语义完全一致）
// ─────────────────────────────────────────────────────────────

/**
 * 创建一个 SSE 解析器。返回的函数接收一段文本，逐行解析 `data:` 负载，
 * 通过 onChunk 吐出增量内容；返回 true 表示收到了 `[DONE]` 结束标记。
 *
 * 同时兼容 `data: {json}` 与 `data:{json}` 两种写法（部分中转站不带空格）。
 */
export function createSseParser(onChunk: (text: string) => void): (chunk: string) => boolean {
  let buffer = '';
  return (chunk: string): boolean => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const data = trimmed.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') return true;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta;
        if (delta && typeof delta.content === 'string' && delta.content) {
          onChunk(delta.content);
        }
      } catch {
        // 忽略不完整或非 JSON 的行
      }
    }
    return false;
  };
}

/** 从非流式（整段 JSON）响应里取出正文，用于服务端忽略 stream 参数的情况。 */
export function extractNonStreamContent(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText);
    const content = parsed?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────
// 系统代理探测
// ─────────────────────────────────────────────────────────────

const PROXY_CACHE_MS = 10_000;
let proxyCache: { at: number; value: string | null } | null = null;

/** 清除代理探测缓存（网络环境变化或全部通道失败后调用）。 */
export function invalidateProxyCache(): void {
  proxyCache = null;
}

/**
 * 探测系统代理，返回形如 `http://127.0.0.1:7897` 的地址；未配置代理时返回 null。
 *
 * 注意：这里探测的是**系统级**代理（Obsidian 渲染进程跟随的那一套），
 * 与浏览器代理扩展无关。只支持 http/https 代理；SOCKS 代理无法用 CONNECT 隧道对接，返回 null。
 */
export async function detectSystemProxy(): Promise<string | null> {
  if (proxyCache && Date.now() - proxyCache.at < PROXY_CACHE_MS) return proxyCache.value;
  let value: string | null = null;
  try {
    value = await detectSystemProxyUncached();
  } catch {
    value = null;
  }
  proxyCache = { at: Date.now(), value };
  return value;
}

async function detectSystemProxyUncached(): Promise<string | null> {
  const proc = loadNodeModule('process');
  const env = (proc?.env ?? {}) as AnyRecord;

  // 1) 环境变量优先（Linux 与各类命令行启动场景）
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim()) {
      const url = normalizeProxyUrl(raw.trim());
      if (url) return url;
    }
  }

  // 2) 系统设置
  const platform = proc?.platform;
  if (platform === 'darwin') return await detectProxyMac();
  if (platform === 'win32') return await detectProxyWindows();
  return null;
}

/** macOS：`scutil --proxy` 输出的是「键 : 值」列表。 */
async function detectProxyMac(): Promise<string | null> {
  const out = await execCapture('/usr/sbin/scutil', ['--proxy']) ?? await execCapture('scutil', ['--proxy']);
  if (!out) return null;

  const readInt = (key: string): number | null => {
    const m = out.match(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const readStr = (key: string): string | null => {
    const m = out.match(new RegExp(`\\b${key}\\s*:\\s*([^\\s]+)`));
    return m ? m[1] : null;
  };
  const pick = (enableKey: string, hostKey: string, portKey: string): string | null => {
    if (readInt(enableKey) !== 1) return null;
    const host = readStr(hostKey);
    const port = readInt(portKey);
    if (!host || !port) return null;
    return normalizeProxyUrl(`${host}:${port}`);
  };

  return pick('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort') ?? pick('HTTPEnable', 'HTTPProxy', 'HTTPPort');
}

/** Windows：读注册表的 Internet Settings。 */
async function detectProxyWindows(): Promise<string | null> {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const enableOut = await execCapture('reg', ['query', key, '/v', 'ProxyEnable']);
  if (!enableOut || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOut)) return null;

  const serverOut = await execCapture('reg', ['query', key, '/v', 'ProxyServer']);
  if (!serverOut) return null;
  const m = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
  if (!m) return null;

  const spec = m[1].trim();
  // 形如 "127.0.0.1:7897" 或 "http=127.0.0.1:7897;https=127.0.0.1:7898"
  if (!spec.includes('=')) return normalizeProxyUrl(spec);
  const parts = spec.split(';').map((s) => s.trim()).filter(Boolean);
  const find = (proto: string) => parts.find((p) => p.toLowerCase().startsWith(`${proto}=`))?.split('=')[1];
  return normalizeProxyUrl(find('https') ?? find('http') ?? '');
}

/** 归一化代理地址：补协议、校验端口、剔除不被支持的 SOCKS。 */
function normalizeProxyUrl(raw: string): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return null;
  if (!url.hostname) return null;

  const port = url.port || (scheme === 'https:' ? '443' : '80');
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ''}@`
    : '';
  return `${scheme}//${auth}${url.hostname}:${port}`;
}

function execCapture(file: string, args: string[], timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const cp = loadNodeModule('child_process');
    if (!cp || typeof cp.execFile !== 'function') {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = cp.execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
        (err: unknown, stdout: string) => done(err ? null : String(stdout ?? '')),
      );
      if (child && typeof child.on === 'function') child.on('error', () => done(null));
    } catch {
      done(null);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Node 流式请求
// ─────────────────────────────────────────────────────────────

export interface NodeChatRequest {
  /** 完整的 chat/completions 地址 */
  url: string;
  headers: Record<string, string>;
  body: string;
  /** 形如 http://127.0.0.1:7897；为空表示直连 */
  proxy?: string | null;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  /** 「连接 + 响应头」超时，响应头到达后自动解除 */
  timeoutMs?: number;
}

export interface NodeChatResult {
  status: number;
  /** status >= 400 时的响应体（已截断） */
  errorBody: string;
}

/**
 * 通过 Node 通道发起一次流式对话请求。
 *
 * - 2xx：按 SSE 逐块解析并通过 onChunk 吐出，resolve 时表示流已结束（或收到 [DONE]）。
 * - >=400：读回响应体后 resolve，由调用方决定如何呈现（不吞状态码）。
 * - 链路失败：抛 TransportError；用户中止抛 kind 为 abort 的 TransportError。
 */
export async function nodeChatStream(req: NodeChatRequest): Promise<NodeChatResult> {
  const http = loadNodeModule('http');
  if (!http) throw new TransportError('network', 'Node 集成不可用');

  let target: URL;
  try {
    target = new URL(req.url);
  } catch {
    throw new TransportError('network', `地址无效：${req.url}`);
  }

  const isTls = target.protocol === 'https:';
  const port = target.port ? Number(target.port) : isTls ? 443 : 80;
  const timeoutMs = req.timeoutMs ?? NODE_CONNECT_TIMEOUT_MS;

  // 环回地址一律直连：Chromium 本身就隐式绕过 loopback，
  // 把本地模型（Ollama / LM Studio / one-api）的请求丢给代理既无意义，
  // 也会因代理的分流规则配置不当而失败。
  const proxy = isLoopbackHost(target.hostname) ? null : req.proxy ?? null;

  if (proxy) {
    const rawSocket = await openTunnel(proxy, target.hostname, port, timeoutMs, req.signal);
    // 隧道里承载的是明文 HTTP；若目标是 https，再手工完成 TLS 握手，
    // 之后把这条已加密的 socket 交给 http 模块直接写明文请求。
    const socket = isTls ? await wrapTls(rawSocket, target.hostname, timeoutMs) : rawSocket;
    return await sendOverSocket(http, socket, target, port, req, timeoutMs);
  }

  if (isTls) {
    const https = loadNodeModule('https');
    if (!https) throw new TransportError('network', 'https 模块不可用');
    return await sendRequest(https, {
      protocol: 'https:',
      host: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: req.headers,
      agent: false,
    }, req, timeoutMs);
  }

  return await sendRequest(http, {
    protocol: 'http:',
    host: target.hostname,
    port,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: req.headers,
    agent: false,
  }, req, timeoutMs);
}

/** 判断是否环回地址（127.0.0.0/8、::1、localhost）。 */
export function isLoopbackHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\./.test(h)) return true;
  return false;
}

/** 走代理的 CONNECT 隧道：先让代理替我们连目标，再在这条连接上说话。 */
async function openTunnel(
  proxyUrl: string,
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AnyRecord> {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new TransportError('network', `代理地址无效：${proxyUrl}`);
  }
  const isTlsProxy = parsed.protocol.toLowerCase() === 'https:';
  const mod = isTlsProxy ? loadNodeModule('https') : loadNodeModule('http');
  if (!mod) throw new TransportError('network', 'Node 集成不可用');

  const proxyPort = Number(parsed.port || (isTlsProxy ? 443 : 80));
  const headers: Record<string, string> = {
    Host: `${host}:${port}`,
    'Proxy-Connection': 'keep-alive',
  };
  if (parsed.username) {
    headers['Proxy-Authorization'] = `Basic ${toBase64(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password ?? '')}`)}`;
  }

  return new Promise<AnyRecord>((resolve, reject) => {
    let settled = false;
    const request = mod.request({
      protocol: isTlsProxy ? 'https:' : 'http:',
      host: parsed.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
    });

    const unbind = bindAbort(request, signal, () => {
      if (settled) return;
      settled = true;
      reject(new TransportError('abort', '已取消'));
    });

    request.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      unbind();
      try { request.destroy(); } catch { /* 忽略 */ }
      reject(new TransportError('network', '代理连接超时'));
    });

    request.on('connect', (res: AnyRecord, socket: AnyRecord) => {
      if (settled) {
        try { socket.destroy(); } catch { /* 忽略 */ }
        return;
      }
      const code = Number(res?.statusCode) || 0;
      if (code !== 200) {
        settled = true;
        unbind();
        try { socket.destroy(); } catch { /* 忽略 */ }
        reject(new TransportError('network', `代理拒绝连接（${code}）`));
        return;
      }
      settled = true;
      unbind();
      request.setTimeout(0);
      resolve(socket);
    });

    request.on('error', (err: AnyRecord) => {
      if (settled) return;
      settled = true;
      unbind();
      reject(new TransportError('network', `代理连接失败：${describe(err)}`));
    });

    request.end();
  });
}

/** 在已建立的隧道 socket 上完成 TLS 握手。ALPN 固定 http/1.1，避免协商出我们不会说的 h2。 */
function wrapTls(socket: AnyRecord, servername: string, timeoutMs: number): Promise<AnyRecord> {
  const tls = loadNodeModule('tls');
  if (!tls || typeof tls.connect !== 'function') {
    throw new TransportError('network', 'tls 模块不可用');
  }

  return new Promise<AnyRecord>((resolve, reject) => {
    let settled = false;
    let tlsSocket: AnyRecord;
    try {
      tlsSocket = tls.connect({
        socket,
        servername,
        host: servername,
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
      });
    } catch (err) {
      reject(new TransportError('network', `TLS 握手失败：${describe(err)}`));
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { tlsSocket.destroy(); } catch { /* 忽略 */ }
      reject(new TransportError('network', 'TLS 握手超时'));
    }, timeoutMs);

    tlsSocket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (err: AnyRecord) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TransportError('network', `TLS 握手失败：${describe(err)}`));
    });
  });
}

/** 把一条已就绪的 socket 交给 http 模块使用（TLS 已在外面完成，这里只写明文 HTTP）。 */
function sendOverSocket(
  http: AnyRecord,
  socket: AnyRecord,
  target: URL,
  port: number,
  req: NodeChatRequest,
  timeoutMs: number,
): Promise<NodeChatResult> {
  const Agent = http.Agent;
  if (typeof Agent !== 'function') throw new TransportError('network', 'http.Agent 不可用');

  // 用实例级 createConnection 把已经就绪的 socket 交给 http 模块；
  // http.Agent 在建立连接时走的就是 this.createConnection，实例属性可以覆盖原型方法。
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (_options: AnyRecord, callback: AnyFn) => {
    callback(null, socket);
    return undefined;
  };

  return sendRequest(http, {
    protocol: 'http:',
    host: target.hostname,
    port,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: req.headers,
    agent,
  }, req, timeoutMs);
}

function sendRequest(
  mod: AnyRecord,
  options: AnyRecord,
  req: NodeChatRequest,
  timeoutMs: number,
): Promise<NodeChatResult> {
  return new Promise<NodeChatResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let request: AnyRecord;
    try {
      request = mod.request(options);
    } catch (err) {
      reject(new TransportError('network', `请求发起失败：${describe(err)}`));
      return;
    }

    const unbind = bindAbort(request, req.signal, () => {
      finish(() => reject(new TransportError('abort', '已取消')));
    });

    request.setTimeout(timeoutMs, () => {
      finish(() => {
        unbind();
        try { request.destroy(); } catch { /* 忽略 */ }
        reject(new TransportError('network', '连接超时'));
      });
    });

    request.on('response', (res: AnyRecord) => {
      const status = Number(res.statusCode) || 0;
      // 响应头已到达，解除连接超时：流式输出可能持续很久，不能按空闲时间切断
      try { request.setTimeout(0); } catch { /* 忽略 */ }
      try { res.setEncoding('utf8'); } catch { /* 忽略 */ }

      if (status >= 400) {
        let body = '';
        res.on('data', (chunk: string) => {
          if (body.length < 4000) body += chunk;
        });
        res.on('end', () => finish(() => { unbind(); resolve({ status, errorBody: body.slice(0, 600) }); }));
        res.on('error', (err: AnyRecord) => finish(() => { unbind(); reject(new TransportError('network', describe(err))); }));
        return;
      }

      const parse = createSseParser(req.onChunk);
      res.on('data', (chunk: string) => {
        if (settled) return;
        if (parse(chunk)) {
          finish(() => {
            unbind();
            try { res.destroy(); } catch { /* 忽略 */ }
            resolve({ status, errorBody: '' });
          });
        }
      });
      res.on('end', () => finish(() => { unbind(); resolve({ status, errorBody: '' }); }));
      res.on('error', (err: AnyRecord) => finish(() => { unbind(); reject(new TransportError('network', describe(err))); }));
    });

    request.on('error', (err: AnyRecord) => {
      finish(() => {
        unbind();
        reject(new TransportError('network', describe(err)));
      });
    });

    try {
      request.end(req.body);
    } catch (err) {
      finish(() => {
        unbind();
        reject(new TransportError('network', `请求发送失败：${describe(err)}`));
      });
    }
  });
}

function bindAbort(request: AnyRecord, signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => { /* 无监听 */ };
  if (signal.aborted) {
    onAbort();
    return () => { /* 立即返回 */ };
  }
  const handler = () => {
    try { request.destroy(); } catch { /* 忽略 */ }
    onAbort();
  };
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

function toBase64(input: string): string {
  const bufferMod = loadNodeModule('buffer');
  if (bufferMod && typeof bufferMod.Buffer === 'function') {
    return bufferMod.Buffer.from(input, 'utf8').toString('base64');
  }
  const g = getGlobal();
  if (typeof g.btoa === 'function') return g.btoa(input) as string;
  return input;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as AnyRecord).code;
    return code ? `${err.message}（${code}）` : err.message;
  }
  return String(err);
}
