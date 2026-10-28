import { z } from 'zod';
import type { ChronicleEntry, GameEvent } from '@tianming/shared';

/**
 * 可选 LLM 史官 Provider（OpenAI 兼容 Chat Completions）。
 * 规则约束：
 * - 只读：仅把史官条目的事实层与事件摘要发给 LLM，绝不发送其他世界状态；
 * - LLM 只产出 literary / inference 表达层文本，facts 永不回写；
 * - 无密钥时 Provider 不可用，游戏仍完整可玩（本地模板史官）。
 * fetch 实现可注入，便于测试；默认使用全局 fetch，不新增依赖。
 */

export interface LlmConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** 从环境变量读取配置；缺少 PROVIDER 或 API_KEY 时返回 null（视为未启用）。 */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const provider = env.LLM_PROVIDER?.trim();
  const apiKey = env.LLM_API_KEY?.trim();
  if (!provider || !apiKey) return null;
  const timeout = Number(env.LLM_TIMEOUT_MS);
  return {
    provider,
    apiKey,
    baseUrl: (env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env.LLM_MODEL?.trim() || 'gpt-4o-mini',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 20_000,
  };
}

/** 与全局 fetch 兼容的最小形状，供测试注入假实现。 */
export interface LlmFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}

export type LlmFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<LlmFetchResponse>;

export interface LlmPolishItem {
  entryId: string;
  literary?: string;
  inference?: string;
}

export type LlmPolishResult =
  | { ok: true; entries: LlmPolishItem[] }
  | { ok: false; code: 'LLM_FAILED' | 'LLM_BAD_RESPONSE'; message: string };

const LITERARY_MAX = 80;
const INFERENCE_MAX = 60;

const polishSchema = z.object({
  entries: z
    .array(
      z.object({
        entryId: z.string().min(1).max(120),
        literary: z.string().max(400).nullish(),
        inference: z.string().max(300).nullish(),
      }),
    )
    .max(20),
});

/**
 * 请求 LLM 为一回合的史官条目生成文学润色与推断。
 * 输入仅为条目的 title/facts 与对应事件 summary；返回结果只包含表达层文本。
 */
export async function polishChronicle(
  entries: ChronicleEntry[],
  events: GameEvent[],
  opts: { config: LlmConfig; fetcher?: LlmFetcher },
): Promise<LlmPolishResult> {
  const { config } = opts;
  const eventById = new Map(events.map((e) => [e.eventId, e]));
  const payload = entries.map((entry) => ({
    entryId: entry.entryId,
    title: entry.title,
    facts: entry.facts,
    events: entry.sourceEventIds.map((id) => eventById.get(id)?.summary).filter(Boolean),
  }));

  const system =
    '你是架空史书《天命史书》的史官，只负责文学表达，绝不改动事实。' +
    '只输出严格 JSON，不要输出任何其他文字、解释或代码块标记。';
  const user = [
    '以下是本旬史官条目的事实层与对应事件摘要（只读，不得改写）。',
    '请为每一条目生成：',
    `1. literary：文学润色，不超过 ${LITERARY_MAX} 字；风格写实残酷，可有黑幽默与偶尔温情，不得使用现代网络梗；`,
    `2. inference：史官推断，不超过 ${INFERENCE_MAX} 字；无必要推断时输出 null。`,
    '禁止改动、增删任何数字、伤亡、任免与领土结果；不得记载事实层与事件摘要之外的内容。',
    '输出严格 JSON：{"entries":[{"entryId":"原样返回","literary":"…","inference":"…或 null"}]}',
    '',
    JSON.stringify({ entries: payload }),
  ].join('\n');

  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as LlmFetcher);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetcher(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, code: 'LLM_FAILED', message: `LLM 服务返回 HTTP ${res.status}。` };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, code: 'LLM_BAD_RESPONSE', message: 'LLM 返回结构异常，缺少文本内容。' };
    }
    const parsed = parsePolishContent(content);
    if (!parsed) {
      return { ok: false, code: 'LLM_BAD_RESPONSE', message: 'LLM 输出不是合法 JSON，已保留原模板条目。' };
    }
    // 只接受本次输入中存在的条目，截断超长文本（表达层截断不影响事实）
    const known = new Set(entries.map((e) => e.entryId));
    const items: LlmPolishItem[] = [];
    for (const item of parsed.entries) {
      if (!known.has(item.entryId)) continue;
      const literary = item.literary?.trim().slice(0, LITERARY_MAX) || undefined;
      const inference = item.inference?.trim().slice(0, INFERENCE_MAX) || undefined;
      if (!literary && !inference) continue;
      items.push({ entryId: item.entryId, literary, inference });
    }
    if (items.length === 0) {
      return { ok: false, code: 'LLM_BAD_RESPONSE', message: 'LLM 输出未包含任何有效条目，已保留原模板条目。' };
    }
    return { ok: true, entries: items };
  } catch {
    const message = controller.signal.aborted
      ? `LLM 请求超时（${config.timeoutMs}ms），已保留原模板条目。`
      : 'LLM 请求失败（网络异常），已保留原模板条目。';
    return { ok: false, code: 'LLM_FAILED', message };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 LLM 输出：容忍代码块围栏，再用 zod 校验结构。 */
function parsePolishContent(content: string): z.infer<typeof polishSchema> | null {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  try {
    const parsed = polishSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
