import { z } from 'zod';
import type { ChronicleEntry, GameEvent } from '@tianming/shared';

/**
 * 可选 LLM 史官 Provider（OpenAI 兼容 Chat Completions）。
 * 规则约束：
 * - 只读：仅把史官条目的事实层与事件摘要发给 LLM，绝不发送其他世界状态；
 * - LLM 只产出 literary / inference 表达层文本，facts 永不回写；
 * - 远程接口无密钥或本地服务未启动时 Provider 不可用，游戏仍完整可玩（本地模板史官）。
 * fetch 实现可注入，便于测试；默认使用全局 fetch，不新增依赖。
 */

export type LlmStyle = 'shiji' | 'yanyi' | 'pingshu';

export const LLM_STYLE_LABELS: Record<LlmStyle, string> = {
  shiji: '史记体',
  yanyi: '演义体',
  pingshu: '评书体',
};

export interface StoredLlmSettings {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  style?: LlmStyle;
  autoPolish?: boolean;
}

export interface LlmConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  style: LlmStyle;
  autoPolish: boolean;
}

export interface LlmStatusView {
  configured: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  style: LlmStyle;
  autoPolish: boolean;
  hasKey: boolean;
  keyHint: string;
  source: 'env' | 'settings' | 'none';
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT = 20_000;

const storedSchema = z.object({
  provider: z.string().trim().max(80).optional(),
  apiKey: z.string().trim().max(400).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
  timeoutMs: z.number().finite().optional(),
  style: z.enum(['shiji', 'yanyi', 'pingshu']).optional(),
  autoPolish: z.boolean().optional(),
});

export function parseStoredLlmSettings(raw: string | null): StoredLlmSettings | null {
  if (!raw) return null;
  try {
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function normalizeStyle(style: string | undefined, envStyle: string | undefined): LlmStyle {
  const value = style ?? envStyle;
  return value === 'shiji' || value === 'pingshu' || value === 'yanyi' ? value : 'yanyi';
}

function isPrivateHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  );
}

export function isLocalLlmEndpoint(baseUrl: string): boolean {
  try {
    return isPrivateHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * 规范 OpenAI 兼容 Base URL：
 * - 只填域名时补 https://（本机地址用 http://）；
 * - 去掉误粘贴的 /chat/completions、/models 等后缀；
 * - 只有域名、没有路径时补 /v1。
 */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  const localLike = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(raw);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `${localLike ? 'http' : 'https'}://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return raw.replace(/\/+$/, '');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw.replace(/\/+$/, '');
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(?:chat\/completions|completions|models)$/i, '');
  if (!path) path = '/v1';
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function authHeaders(config: LlmConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

/** 从环境变量与本机设置读取配置；远程接口缺 API_KEY 或提供商无法识别时返回 null。 */
export function loadLlmConfig(
  env: NodeJS.ProcessEnv = process.env,
  stored?: StoredLlmSettings | null,
): LlmConfig | null {
  const baseUrl = normalizeBaseUrl(
    stored?.baseUrl?.trim() || env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
  );
  const apiKey = stored?.apiKey?.trim() || env.LLM_API_KEY?.trim() || '';
  const local = isLocalLlmEndpoint(baseUrl);
  const provider =
    stored?.provider?.trim() ||
    env.LLM_PROVIDER?.trim() ||
    (apiKey ? 'custom' : local ? 'ollama' : '');
  if (!provider) return null;
  // 远程服务必须有密钥；本机 / 局域网端点（Ollama 等）允许免密钥。
  if (!apiKey && !local && provider !== 'ollama') return null;
  const timeout = Number(stored?.timeoutMs ?? env.LLM_TIMEOUT_MS);
  return {
    provider,
    apiKey,
    baseUrl,
    model: stored?.model?.trim() || env.LLM_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout >= 5000 ? Math.min(timeout, 120_000) : DEFAULT_TIMEOUT,
    style: normalizeStyle(stored?.style, env.LLM_STYLE),
    autoPolish: stored?.autoPolish === true,
  };
}

/** 返回可安全下发给前端的配置摘要：绝不包含完整密钥。 */
export function describeLlmConfig(
  env: NodeJS.ProcessEnv = process.env,
  stored?: StoredLlmSettings | null,
): LlmStatusView {
  const config = loadLlmConfig(env, stored);
  const hasStored = Boolean(stored && (stored.provider || stored.apiKey || stored.baseUrl || stored.model));
  const source: LlmStatusView['source'] = hasStored
    ? 'settings'
    : env.LLM_PROVIDER || env.LLM_API_KEY
      ? 'env'
      : 'none';
  const baseUrl = normalizeBaseUrl(
    config?.baseUrl || stored?.baseUrl || env.LLM_BASE_URL || DEFAULT_BASE_URL,
  );
  return {
    configured: Boolean(config),
    provider: config?.provider ?? stored?.provider?.trim() ?? env.LLM_PROVIDER?.trim() ?? '',
    baseUrl,
    model: config?.model ?? (stored?.model || env.LLM_MODEL || DEFAULT_MODEL),
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT,
    style: config?.style ?? normalizeStyle(stored?.style, env.LLM_STYLE),
    autoPolish: config?.autoPolish ?? stored?.autoPolish === true,
    hasKey: Boolean(config?.apiKey),
    keyHint: config?.apiKey ? `••••${config.apiKey.slice(-4)}` : '',
    source,
  };
}

/** 与全局 fetch 兼容的最小形状，供测试注入假实现。 */
export interface LlmFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get?: (name: string) => string | null };
  text?: () => Promise<string>;
  json: () => Promise<any>;
}

export interface LlmFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type LlmFetcher = (url: string, init: LlmFetchInit) => Promise<LlmFetchResponse>;

async function readErrorSnippet(res: LlmFetchResponse): Promise<string> {
  if (!res.text) return '';
  try {
    const raw = await res.text();
    return raw
      .replace(/\s+/g, ' ')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***')
      .trim()
      .slice(0, 180);
  } catch {
    return '';
  }
}

function httpFailureReason(status: number, res: LlmFetchResponse): string {
  if (res.headers?.get?.('x-render-routing') === 'no-server') {
    return '目标 Render 服务不存在或已停止';
  }
  if (status === 401 || status === 403) return '密钥无效、已过期或无权访问该模型';
  if (status === 404) return '接口地址不存在；请检查 Base URL 是否需要 /v1，或服务是否已下线';
  if (status === 429) return '请求被限流或额度不足，请稍后再试';
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return '上游服务不可用；代理或网关可能已停止、冷启动中或地址已迁移';
  }
  return `服务返回 HTTP ${status}`;
}

function withSnippet(reason: string, snippet: string): string {
  return snippet ? `${reason}（${snippet}）` : reason;
}

export interface LlmPolishItem {
  entryId: string;
  literary?: string;
  inference?: string;
}

export type LlmPolishResult =
  | { ok: true; entries: LlmPolishItem[] }
  | { ok: false; code: 'LLM_FAILED' | 'LLM_BAD_RESPONSE'; message: string };

export interface LlmProbeResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

const LITERARY_MAX = 420;
const INFERENCE_MAX = 180;

const polishSchema = z.object({
  entries: z
    .array(
      z.object({
        entryId: z.string().min(1).max(120),
        literary: z.string().max(900).nullish(),
        inference: z.string().max(400).nullish(),
      }),
    )
    .max(20),
});

const STYLE_INSTRUCTIONS: Record<LlmStyle, string> = {
  shiji:
    '文风取《史记》纪传体：简练、冷峻、克制，少用形容词，以事写人；每条约 120–220 字。',
  yanyi:
    '文风取《三国演义》章回小说：先铺陈局势与计谋，再写人物动作、对话与心理，最后落到战果；可用“却说”“只见”“忽报”等古典小说语汇，但不得使用现代网络梗；每条约 220–360 字。',
  pingshu:
    '文风取评书：说书人口吻，短句、设问、转折，节奏明快；每条约 180–300 字。',
};

const DETAIL_KEYS = [
  'scheme',
  'success',
  'chance',
  'roll',
  'ratio',
  'attackerPower',
  'defenderPower',
  'attackerCommander',
  'defenderCommander',
  'totalLosses',
  'attackerLosses',
  'defenderLosses',
  'garrisonLosses',
  'terrain',
  'weather',
  'maneuverBonus',
  'ambushBonus',
  'diversionBonus',
  'reliability',
] as const;

function eventContext(event: GameEvent | undefined): Record<string, unknown> | null {
  if (!event) return null;
  const payload = event.payload ?? {};
  const details: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    if (key in payload) details[key] = payload[key];
  }
  return {
    type: event.type,
    title: event.title,
    summary: event.summary,
    actor: event.actorName,
    target: event.targetLabel,
    dateLabel: event.dateLabel,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

/**
 * 请求 LLM 为一回合的史官条目生成文学润色与推断。
 * 输入仅为条目的 title/facts 与对应事件摘要；返回结果只包含表达层文本。
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
    kind: entry.kind,
    title: entry.title,
    facts: entry.facts,
    events: entry.sourceEventIds.map((id) => eventContext(eventById.get(id))).filter(Boolean),
  }));

  const system =
    '你是架空史书《天命史书》的史官，只负责文学表达，绝不改动事实。' +
    '只输出严格 JSON，不要输出任何其他文字、解释或代码块标记。';
  const style = STYLE_INSTRUCTIONS[config.style] ?? STYLE_INSTRUCTIONS.yanyi;
  const user = [
    '以下是本旬史官条目的事实层与对应事件（只读，不得改写）。',
    `文风要求：${style}`,
    '请为每一条目生成：',
    `1. literary：文学润色，可分段，最多 ${LITERARY_MAX} 字。要写出局势、人物动作/对话/心理与结果；若事件为计谋，必须写清谁定计、如何伪装或诱敌、敌方如何反应、计成还是被识破；若事件为战斗，必须写清统兵者、兵力对比、地形与胜负。`,
    `2. inference：史官推断，最多 ${INFERENCE_MAX} 字；无必要推断时输出 null。`,
    '事实边界：不得新增事实层与事件中没有的人名、地名、数字、胜负、伤亡、任免与领土结果；不得把失败写成成功；不得复述 facts 原文充数。',
    '输出严格 JSON：{"entries":[{"entryId":"原样返回","literary":"…","inference":"…或 null"}]}',
    '',
    JSON.stringify({ entries: payload }),
  ].join('\n');

  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as LlmFetcher);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const send = (jsonMode: boolean) =>
      fetcher(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.8,
          max_tokens: 3500,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
    let res = await send(true);
    // 部分兼容接口不支持 response_format，退回纯提示词约束。
    if (!res.ok && (res.status === 400 || res.status === 422)) res = await send(false);
    if (!res.ok) {
      const snippet = await readErrorSnippet(res);
      return {
        ok: false,
        code: 'LLM_FAILED',
        message: `LLM 润色失败：${withSnippet(httpFailureReason(res.status, res), snippet)}，已保留原模板条目。`,
      };
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

/** 连通性测试：发一个极小请求，确认地址、密钥与模型可用。 */
export async function testLlmConnection(
  config: LlmConfig,
  opts: { fetcher?: LlmFetcher } = {},
): Promise<LlmProbeResult> {
  const started = Date.now();
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as LlmFetcher);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 15_000));
  try {
    const res = await fetcher(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是连接测试助手，只回复 OK。' },
          { role: 'user', content: '回复 OK' },
        ],
        temperature: 0,
        max_tokens: 8,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const snippet = await readErrorSnippet(res);
      return {
        ok: false,
        latencyMs,
        message: `连接失败：${withSnippet(httpFailureReason(res.status, res), snippet)} · ${config.baseUrl}`,
      };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, latencyMs, message: '服务可达，但返回结构不是 OpenAI 兼容 Chat Completions。' };
    }
    return { ok: true, latencyMs, message: `连接成功：${config.model} · ${latencyMs}ms` };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: controller.signal.aborted
        ? `连接超时（${Math.min(config.timeoutMs, 15_000)}ms） · ${config.baseUrl}`
        : `连接失败：网络异常、DNS 解析失败或接口地址不可达 · ${config.baseUrl}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface LlmModelsResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  message: string;
}

/** 拉取 /models 列表，帮助确认地址与密钥有效，并选择正确模型名。 */
export async function listLlmModels(
  config: LlmConfig,
  opts: { fetcher?: LlmFetcher } = {},
): Promise<LlmModelsResult> {
  const started = Date.now();
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as LlmFetcher);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 15_000));
  try {
    const res = await fetcher(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: authHeaders(config),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const snippet = await readErrorSnippet(res);
      return {
        ok: false,
        latencyMs,
        models: [],
        message: `获取模型失败：${withSnippet(httpFailureReason(res.status, res), snippet)} · ${config.baseUrl}`,
      };
    }
    const data = await res.json();
    const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models = raw
      .map((item: any) => (typeof item === 'string' ? item : item?.id))
      .filter((id: any): id is string => typeof id === 'string' && id.trim().length > 0)
      .slice(0, 300);
    return {
      ok: true,
      latencyMs,
      models,
      message:
        models.length > 0
          ? `服务可达，发现 ${models.length} 个模型。`
          : '服务可达，但未返回模型列表；可直接手动填写模型名。',
    };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      models: [],
      message: controller.signal.aborted
        ? `获取模型超时（${Math.min(config.timeoutMs, 15_000)}ms） · ${config.baseUrl}`
        : `获取模型失败：网络异常、DNS 解析失败或接口地址不可达 · ${config.baseUrl}`,
    };
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
