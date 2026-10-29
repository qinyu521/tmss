import { useEffect, useState } from 'react';
import { api, type LlmSettingsPatch, type LlmStatus, type LlmStyle } from '../api/client';
import { useApp } from '../state/store';

const PRESETS: { label: string; provider: string; baseUrl: string; model: string }[] = [
  { label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Moonshot', provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  {
    label: '通义千问',
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { label: '智谱 GLM', provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  {
    label: '硅基流动',
    provider: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
  },
  {
    label: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
  },
  { label: 'Ollama 本机', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

function looksLocal(baseUrl: string): boolean {
  return /(?:^|:\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(baseUrl) || /^https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(baseUrl);
}

const STYLE_LABELS: Record<LlmStyle, string> = {
  shiji: '史记体（简练冷峻）',
  yanyi: '演义体（章回小说，推荐）',
  pingshu: '评书体（说书节奏）',
};

interface FormState {
  provider: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  style: LlmStyle;
  autoPolish: boolean;
  apiKey: string;
}

const DEFAULT_FORM: FormState = {
  provider: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  timeoutMs: 20_000,
  style: 'yanyi',
  autoPolish: false,
  apiKey: '',
};

function formFromStatus(status: LlmStatus): FormState {
  return {
    provider: status.provider,
    baseUrl: status.baseUrl,
    model: status.model,
    timeoutMs: status.timeoutMs,
    style: status.style,
    autoPolish: status.autoPolish,
    apiKey: '',
  };
}

export default function LlmSettings() {
  const refreshConfig = useApp((s) => s.refreshConfig);
  const notify = useApp((s) => s.notify);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelMessage, setModelMessage] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .llmConfig()
      .then((data) => {
        if (!alive) return;
        setStatus(data);
        setForm(formFromStatus(data));
      })
      .catch((err: any) => {
        if (alive) setLoadError(err?.message ?? '无法读取 AI 史官设置');
      });
    return () => {
      alive = false;
    };
  }, []);

  const patch = (): LlmSettingsPatch => ({
    provider: form.provider.trim(),
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    timeoutMs: Math.round(Number(form.timeoutMs) || 20_000),
    style: form.style,
    autoPolish: form.autoPolish,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  });

  const save = async () => {
    setSaving(true);
    setProbe(null);
    try {
      const next = await api.saveLlmConfig(patch());
      setStatus(next);
      setForm((prev) => ({
        ...prev,
        provider: next.provider,
        baseUrl: next.baseUrl,
        model: next.model,
        timeoutMs: next.timeoutMs,
        style: next.style,
        autoPolish: next.autoPolish,
        apiKey: '',
      }));
      await refreshConfig();
      notify(next.configured ? 'AI 史官设置已保存' : '设置已保存，但尚缺服务商或密钥', next.configured ? 'success' : 'info');
    } catch (err: any) {
      notify(err?.message ?? '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setProbe(null);
    try {
      const result = await api.testLlm({ ...patch(), apiKey: form.apiKey.trim() });
      setProbe(result);
    } catch (err: any) {
      setProbe({ ok: false, message: err?.message ?? '连接测试失败' });
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async () => {
    if (!confirm('清除本机保存的 API Key？环境变量中的密钥不受影响。')) return;
    setSaving(true);
    setProbe(null);
    try {
      const next = await api.saveLlmConfig({ clearApiKey: true });
      setStatus(next);
      await refreshConfig();
      notify('本机 API Key 已清除', 'info');
    } catch (err: any) {
      notify(err?.message ?? '清除失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const loadModels = async () => {
    setFetchingModels(true);
    setProbe(null);
    setModelMessage('');
    try {
      const result = await api.listLlmModels({ ...patch(), apiKey: form.apiKey.trim() });
      setModels(result.models);
      setModelMessage(result.message);
      if (!result.ok) setProbe({ ok: false, message: result.message });
      else if (!form.model.trim() && result.models[0]) setForm((prev) => ({ ...prev, model: result.models[0] }));
    } catch (err: any) {
      setModels([]);
      const message = err?.message ?? '获取模型失败';
      setModelMessage(message);
      setProbe({ ok: false, message });
    } finally {
      setFetchingModels(false);
    }
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setForm((prev) => ({
      ...prev,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      model: preset.model,
    }));
    setModels([]);
    setModelMessage('');
    setProbe(null);
  };

  return (
    <>
      <div className="llm-status">
        {status ? (
          <>
            <span className={`chip ${status.configured ? 'ok' : 'danger'}`}>
              {status.configured ? '已配置' : '未配置'}
            </span>
            <span className="chip">
              来源：{status.source === 'env' ? '环境变量' : status.source === 'settings' ? '本机设置' : '无'}
            </span>
            {status.configured && <span className="chip gold">{status.model}</span>}
            {status.hasKey && <span className="small muted">密钥 {status.keyHint}</span>}
            {status.configured && !status.hasKey && <span className="chip">免密钥（本地）</span>}
          </>
        ) : (
          <span className="small muted">{loadError || '读取设置中…'}</span>
        )}
      </div>

      <div className="form-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <label>快速填写</label>
        {PRESETS.map((preset) => (
          <button key={preset.label} className="btn small ghost" onClick={() => applyPreset(preset)}>
            {preset.label}
          </button>
        ))}
      </div>

      <div className="form-row">
        <label>服务商标识</label>
        <input
          value={form.provider}
          placeholder="如 openai / deepseek / ollama；仅作标记"
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
        />
      </div>
      <div className="form-row">
        <label>API 地址</label>
        <input
          value={form.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(e) => {
            setForm({ ...form, baseUrl: e.target.value });
            setModels([]);
            setModelMessage('');
            setProbe(null);
          }}
        />
      </div>
      <div className="form-note" style={{ marginLeft: 100 }}>
        填到 /v1 为止。只填域名会自动补 /v1，误粘贴的 /chat/completions 会自动去掉；本机地址自动使用 http。
      </div>
      <div className="form-row">
        <label>模型</label>
        <input
          value={form.model}
          placeholder="如 gpt-4o-mini / deepseek-chat"
          onChange={(e) => setForm({ ...form, model: e.target.value })}
        />
        <button
          className="btn small ghost"
          style={{ flex: '0 0 auto' }}
          disabled={fetchingModels || saving || testing}
          onClick={() => void loadModels()}
        >
          {fetchingModels ? '获取中…' : '获取模型'}
        </button>
      </div>
      {models.length > 0 && (
        <div className="form-row">
          <label>可用模型</label>
          <select
            value={models.includes(form.model) ? form.model : ''}
            onChange={(e) => {
              if (e.target.value) setForm({ ...form, model: e.target.value });
            }}
          >
            <option value="">选择已发现的模型…</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
      )}
      {modelMessage && <div className="form-note">{modelMessage}</div>}
      <div className="form-row">
        <label>API Key</label>
        <input
          type="password"
          value={form.apiKey}
          autoComplete="new-password"
          placeholder={
            status?.hasKey
              ? `已保存 ${status.keyHint}，留空则不修改`
              : looksLocal(form.baseUrl)
                ? '本地 Ollama 等端点可留空'
                : '粘贴 API Key'
          }
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
        />
      </div>
      <div className="form-row">
        <label>文风</label>
        <select value={form.style} onChange={(e) => setForm({ ...form, style: e.target.value as LlmStyle })}>
          {(Object.keys(STYLE_LABELS) as LlmStyle[]).map((key) => (
            <option key={key} value={key}>
              {STYLE_LABELS[key]}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>超时（毫秒）</label>
        <input
          type="number"
          min={5000}
          max={120000}
          step={1000}
          value={form.timeoutMs}
          onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })}
        />
      </div>
      <label className="form-row" style={{ cursor: 'pointer' }}>
        <span style={{ width: 90, color: 'var(--muted)', fontSize: 11 }}>自动润色</span>
        <input
          type="checkbox"
          checked={form.autoPolish}
          onChange={(e) => setForm({ ...form, autoPolish: e.target.checked })}
          style={{ flex: '0 0 auto' }}
        />
        <span className="small muted">每旬结算后自动请 AI 重写史官条目（仅表达层）</span>
      </label>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button className="btn primary" disabled={saving || testing} onClick={() => void save()}>
          {saving ? '保存中…' : '保存设置'}
        </button>
        <button className="btn" disabled={saving || testing} onClick={() => void test()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        {status?.source === 'settings' && status.hasKey && (
          <button className="btn danger small" disabled={saving || testing} onClick={() => void clearKey()}>
            清除本机密钥
          </button>
        )}
      </div>

      {probe && (
        <div className={`llm-probe ${probe.ok ? 'ok' : 'bad'}`}>
          {probe.ok ? '✓ ' : '✗ '}
          {probe.message}
        </div>
      )}

      <div className="form-note">
        连不上时依次检查：① 服务是否仍在线（Render 等免费实例会休眠或删除，根路径也 404 通常表示服务已停）；
        ② 地址是否以 /v1 结尾；③ 密钥是否有效、有余额；④ 模型名是否出现在「获取模型」列表中。
        本机 Ollama 填 http://127.0.0.1:11434/v1，密钥可留空。
      </div>

      <div className="form-note">
        支持任意 OpenAI 兼容的 Chat Completions 接口。密钥只保存在本机 SQLite（data/runtime/tianming.db），
        接口只回传掩码；不会写入存档、日志或仓库。未配置时游戏完全可玩，史官使用本地模板。
      </div>
    </>
  );
}
