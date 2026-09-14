/**
 * AI 服务 —— 多通道流式对话
 *
 * 通道优先级（越靠前改动越小、体验越好）：
 *   1. fetch            渲染进程原生请求，**原有行为**，成功即逐字流式
 *   2. Node + 系统代理   免 CORS，保留逐字流式（国内用户开代理访问境外端点的常见路径）
 *   3. Node 直连         免 CORS，保留逐字流式
 *   4. requestUrl       免 CORS 但不支持流式，仅在前三条都失败时兜底
 *
 * 背景：Obsidian 渲染进程的 origin 是 `app://obsidian.md`，原生 fetch 受同源策略约束。
 * 官方 OpenAI / Anthropic 的 POST 响应不返回 Access-Control-Allow-Origin，会被浏览器拦下，
 * 而请求其实已经打到服务端了——这就是「测试连接成功、一对话就报网络错误」的成因。
 *
 * 三条硬约束：
 *   · 国内用户零影响：通道 1 成功时后续代码一行都不执行；只有「快速失败」才回退，
 *     真网络故障（耗时超过 SLOW_FAIL_MS）直接如实报错，不让用户多等一轮。
 *   · 境外用户体验对齐：回退通道同样走 SSE 逐块解析，不牺牲打字机效果。
 *   · 改动不外溢：只动模型连接，标注、PDF 与界面逻辑不碰。
 */
import { requestUrl } from 'obsidian';
import type FleurPDFPlugin from './main';
import {
  TransportError,
  createSseParser,
  detectSystemProxy,
  extractNonStreamContent,
  invalidateProxyCache,
  isNodeTransportAvailable,
  nodeChatStream,
  resolveChatEndpoint,
} from './ai-transport';

/** 失败耗时超过此值判定为真网络故障，不再换通道重试（避免国内用户多等一轮）。 */
const SLOW_FAIL_MS = 3000;

/** 通道可用性记忆的存活时间。 */
const CHANNEL_HINT_TTL_MS = 10 * 60 * 1000;

type ChannelName = 'fetch' | 'node';

/**
 * 记住某个端点「哪条通道能用」。只缓存成功结果，且仅用于跳过注定失败的通道 1，
 * 省掉那次必然失败的请求（对官方端点而言，这次请求会真的打到服务端并消耗额度）。
 */
const channelHints = new Map<string, { channel: ChannelName; at: number }>();

function readChannelHint(endpoint: string): ChannelName | null {
  const hit = channelHints.get(endpoint);
  if (!hit) return null;
  if (Date.now() - hit.at > CHANNEL_HINT_TTL_MS) {
    channelHints.delete(endpoint);
    return null;
  }
  return hit.channel;
}

function rememberChannel(endpoint: string, channel: ChannelName): void {
  channelHints.set(endpoint, { channel, at: Date.now() });
}

/** 通道层结果：ok=流已正常结束；http=拿到了状态码；network=链路失败；aborted=用户中止。 */
type ChannelOutcome =
  | { kind: 'ok' }
  | { kind: 'aborted' }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'network'; message: string };

export class AIService {
  constructor(private plugin: FleurPDFPlugin) {}

  async streamChat(
    messages: Array<{ role: string; content: string }>,
    onChunk: (content: string) => void,
    onDone?: () => void,
    onError?: (error: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const { apiKey, baseUrl, model, temperature } = this.plugin.settings;

    if (!apiKey) {
      onError?.('请先在设置中配置 API Key');
      return;
    }

    const endpoint = resolveChatEndpoint(baseUrl);
    if (!endpoint) {
      onError?.('请先在设置中填写 Base URL（例如 https://api.deepseek.com/v1）');
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    const payload = JSON.stringify({ model, messages, stream: true, temperature });

    let emitted = false;
    const emit = (text: string) => {
      emitted = true;
      onChunk(text);
    };

    // ── 通道 1：原生 fetch（原有行为）────────────────────────────
    if (readChannelHint(endpoint) !== 'node') {
      const startedAt = Date.now();
      const outcome = await this.fetchChannel(endpoint, headers, payload, emit, signal);

      if (outcome.kind === 'ok') {
        rememberChannel(endpoint, 'fetch');
        onDone?.();
        return;
      }
      if (outcome.kind === 'aborted') return;
      if (outcome.kind === 'http') {
        onError?.(`请求失败 (${outcome.status}): ${outcome.body}`);
        return;
      }

      // 网络层失败。已经吐出过内容就不能换通道重放，否则界面上的文字会重复。
      if (emitted) {
        onError?.('连接中断，请重试');
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      if (!isNodeTransportAvailable()) {
        onError?.(outcome.message);
        return;
      }
      if (elapsedMs >= SLOW_FAIL_MS) {
        // 真网络故障（TCP 超时级别），换通道同样救不回来，直接如实报错，不让用户多等一轮
        onError?.(`${outcome.message}（${Math.round(elapsedMs / 1000)} 秒无响应，请检查网络或代理设置）`);
        return;
      }
    }

    // ── 通道 2 / 3：Node 流式（免 CORS，保留逐字输出）──────────────
    if (isNodeTransportAvailable()) {
      const proxy = await detectSystemProxy();
      const attempts: Array<string | null> = proxy ? [proxy, null] : [null];
      let lastError = '';

      for (const attemptProxy of attempts) {
        if (signal?.aborted) return;
        try {
          const result = await nodeChatStream({
            url: endpoint,
            headers,
            body: payload,
            proxy: attemptProxy,
            signal,
            onChunk: emit,
          });

          if (result.status >= 200 && result.status < 300) {
            rememberChannel(endpoint, 'node');
            if (signal?.aborted) return;
            onDone?.();
            return;
          }

          // 链路已经打通，是服务端返回的状态码错误：如实呈现，不再换通道
          onError?.(`请求失败 (${result.status}): ${result.errorBody}`);
          return;
        } catch (err) {
          if (signal?.aborted || (err instanceof TransportError && err.kind === 'abort')) return;
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      // ── 通道 4：requestUrl 兜底（不支持流式，仅前面都失败时使用）──
      if (signal?.aborted) return;
      const fallback = await this.requestUrlChannel(endpoint, headers, payload, emit);
      if (signal?.aborted) return;
      if (fallback.kind === 'ok') {
        onDone?.();
        return;
      }
      if (fallback.kind === 'http') {
        onError?.(`请求失败 (${fallback.status}): ${fallback.body}`);
        return;
      }
      if (fallback.kind === 'aborted') return;
      // 全部通道都失败：清掉代理缓存与通道记忆，下次重新探测
      invalidateProxyCache();
      channelHints.delete(endpoint);
      onError?.(lastError || fallback.message);
      return;
    }

    // 所有通道都不可用（环境不支持 Node，且原生请求已失败）：如实报错，不能让界面停在「生成中」
    if (!emitted) onError?.('无法建立连接，请检查网络与代理设置');
  }

  /** 通道 1：原生 fetch。SSE 需要真实流式读取，故不能用 requestUrl 代替。 */
  private async fetchChannel(
    endpoint: string,
    headers: Record<string, string>,
    payload: string,
    emit: (text: string) => void,
    signal?: AbortSignal
  ): Promise<ChannelOutcome> {
    try {
      // Obsidian's requestUrl does not support SSE streaming; native fetch is required.
      // eslint-disable-next-line no-restricted-syntax -- SSE streaming requires native fetch
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { kind: 'http', status: response.status, body: errorText };
      }

      const reader = response.body?.getReader();
      if (!reader) return { kind: 'network', message: '无法读取响应流' };

      const decoder = new TextDecoder();
      const parse = createSseParser(emit);
      let sawDone = false;

      while (!sawDone) {
        if (signal?.aborted) {
          void reader.cancel();
          return { kind: 'aborted' };
        }
        const { done, value } = await reader.read();
        if (done) break;
        sawDone = parse(decoder.decode(value, { stream: true }));
      }

      if (signal?.aborted) return { kind: 'aborted' };
      if (sawDone) void reader.cancel();
      return { kind: 'ok' };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return { kind: 'aborted' };
      if (signal?.aborted) return { kind: 'aborted' };
      return { kind: 'network', message: describeNetworkError(err) };
    }
  }

  /**
   * 通道 4：requestUrl。走主进程，天然免 CORS 且跟随系统代理，但不支持 SSE，
   * 只能整段拿到响应后一次性解析，仅作最后兜底。
   */
  private async requestUrlChannel(
    endpoint: string,
    headers: Record<string, string>,
    payload: string,
    emit: (text: string) => void
  ): Promise<ChannelOutcome> {
    try {
      const response = await requestUrl({
        url: endpoint,
        method: 'POST',
        headers,
        body: payload,
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        return { kind: 'http', status: response.status, body: response.text.slice(0, 600) };
      }

      const text = response.text;
      const parse = createSseParser(emit);
      let sawDone = false;
      // 按 SSE 逐块喂给解析器（此时数据已整体到手，仅为复用同一套解析语义）
      for (const line of text.split('\n')) {
        if (sawDone) break;
        sawDone = parse(`${line}\n`);
      }

      // 服务端忽略了 stream 参数、直接返回整段 JSON 时，这里把正文补齐取出
      if (!sawDone) {
        const content = extractNonStreamContent(text);
        if (content) emit(content);
      }
      return { kind: 'ok' };
    } catch (err: unknown) {
      return { kind: 'network', message: describeNetworkError(err) };
    }
  }
}

/** 把浏览器的模糊报错换成能指导排查的中文描述。 */
function describeNetworkError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const blocked = '无法建立连接（可能被同源策略拦截，或网络不可达）';
  switch (raw) {
    case 'Failed to fetch':
    case 'Load failed':
    case 'NetworkError when attempting to fetch resource.':
      return blocked;
    case 'network error':
      return '网络连接中断';
    default:
      return raw;
  }
}
