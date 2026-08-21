/**
 * AI 服务 - 使用原生 fetch 实现真正的流式输出
 * SSE streaming 需要原生 fetch，无法使用 Obsidian 的 requestUrl
 */
import type FleurPDFPlugin from './main';

export class AIService {
  constructor(private plugin: FleurPDFPlugin) {}

  async streamChat(
    messages: Array<{ role: string; content: string }>,
    onChunk: (content: string) => void,
    onDone?: () => void,
    onError?: (error: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const { apiKey, baseUrl, model } = this.plugin.settings;

    if (!apiKey) {
      onError?.('请先在设置中配置 API Key');
      return;
    }

    const url = `${baseUrl}/chat/completions`;

    try {
      // SSE streaming 需要原生 fetch，requestUrl 不支持流式响应（eslint-disable-next-line）
      // eslint-disable-next-line no-restricted-syntax
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true
        }),
        signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        onError?.(`请求失败 (${response.status}): ${errorText}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError?.('无法读取响应流');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (signal?.aborted) {
          void reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            onDone?.();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (choice?.delta?.content) {
              onChunk(choice.delta.content);
            }
          } catch {
            // 忽略 JSON 解析错误
          }
        }
      }

      if (signal?.aborted) return;
      onDone?.();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const errorMsg = err instanceof Error ? err.message : '网络请求失败';
      onError?.(errorMsg);
    }
  }
}
