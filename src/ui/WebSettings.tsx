import { useEffect, useRef, useState } from 'react';
import { CheckCircle, CircleNotch, Eye, EyeSlash, SlidersHorizontal, X, ArrowClockwise } from '@phosphor-icons/react';
import type { ProviderDraft, ProviderState } from '../shared/web.js';
import type { ReaderModel } from '../shared/models.js';
import type { ReaderBridge } from './bridge.js';

export function WebSettings({ bridge, onClose, onSaved }: { bridge: ReaderBridge; onClose: () => void; onSaved: (state: ProviderState) => void }) {
  const [state, setState] = useState<ProviderState | null>(bridge.provider ?? null);
  const [draft, setDraft] = useState<ProviderDraft>({ mode: bridge.provider?.mode ?? 'api', baseUrl: bridge.provider?.baseUrl ?? 'https://api.openai.com/v1', model: bridge.provider?.model ?? '', stream: bridge.provider?.stream ?? true, rememberKey: bridge.provider?.rememberKey ?? false });
  const [key, setKey] = useState(''); const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<ReaderModel[]>([]);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  const panel = useRef<HTMLDivElement>(null); const disposed = useRef(false); const edited = useRef(false);
  useEffect(() => {
    disposed.current = false; const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    void bridge.webRequest<ProviderState>('/api/provider').then(value => { if (!disposed.current) { setState(value); if (!edited.current) setDraft({ mode: value.mode, baseUrl: value.baseUrl, model: value.model, stream: value.stream, rememberKey: value.rememberKey }); } }).catch(e => { if (!disposed.current) setError(e.message); });
    return () => { disposed.current = true; previous?.focus(); };
  }, [bridge]);
  function update(next: Partial<ProviderDraft>) { edited.current = true; setDraft(value => ({ ...value, ...next })); setSuccess(''); }
  const payload = (): ProviderDraft => ({ ...draft, ...(key ? { apiKey: key } : {}) });
  async function action(kind: 'save' | 'models' | 'test') {
    if (busy) return; setBusy(kind); setError(''); setSuccess('');
    try {
      if (kind === 'save') { const next = await bridge.webRequest<ProviderState>('/api/provider', 'POST', payload()); bridge.provider = next; if (!disposed.current) onSaved(next); }
      if (kind === 'models') { const result = await bridge.webRequest<{ models: ReaderModel[] }>('/api/provider/models', 'POST', payload(), 30000); if (!disposed.current) { setModels(result.models); setSuccess(`已读取 ${result.models.length} 个模型，也可直接填写模型 ID。`); } }
      if (kind === 'test') { const result = await bridge.webRequest<{ elapsedMs: number }>('/api/provider/test', 'POST', payload(), 110000); if (!disposed.current) setSuccess(`连接成功，模型响应 ${(result.elapsedMs / 1000).toFixed(1)} 秒。`); }
    } catch (e) { if (!disposed.current) setError(e instanceof Error ? e.message : '操作失败，请重试。'); }
    finally { if (!disposed.current) setBusy(''); }
  }
  return <div className="project-picker-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="model-settings web-settings" role="dialog" aria-modal="true" aria-labelledby="web-settings-title" ref={panel} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
      if (e.key !== 'Tab') return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? [])].filter(el => el.offsetParent !== null);
      if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
    }}>
      <header className="picker-heading"><div><SlidersHorizontal size={25} /><div><h2 id="web-settings-title">模型与 API</h2><p>为代码解释、文件用途和导图总结配置模型。</p></div></div><button className="icon-button" aria-label="关闭 API 设置" disabled={!!busy} onClick={onClose}><X size={20} /></button></header>
      <div className="model-settings-body"><div className="provider-tabs" role="group" aria-label="模型连接方式"><button aria-pressed={draft.mode === 'api'} disabled={!!busy} onClick={() => { if (draft.mode !== 'api') update({ mode: 'api', model: '' }); setModels([]); }}>API 接口</button><button aria-pressed={draft.mode === 'codex'} disabled={!!busy} onClick={() => { if (draft.mode !== 'codex') update({ mode: 'codex', model: '' }); setModels([]); }}>本机 Codex</button></div>
      {draft.mode === 'api' ? <><label htmlFor="api-base-url">API 基础地址</label><input id="api-base-url" type="url" value={draft.baseUrl} disabled={!!busy} placeholder="https://api.openai.com/v1" onChange={e => { update({ baseUrl: e.target.value }); setModels([]); }} />
      <label htmlFor="api-key">API Key <span className="field-hint">{state?.keySet && !draft.clearKey ? '已设置；留空保留同一提供方的密钥' : '本地免鉴权模型可留空'}</span></label><div className="api-key-field"><input id="api-key" type={showKey ? 'text' : 'password'} autoComplete="new-password" value={key} disabled={!!busy} placeholder="填写提供方的 API Key" onChange={e => { setKey(e.target.value); update({ clearKey: false }); }} /><button className="icon-button" aria-label={showKey ? '隐藏新填写的密钥' : '显示新填写的密钥'} onClick={() => setShowKey(v => !v)}>{showKey ? <EyeSlash size={17} /> : <Eye size={17} />}</button></div>
      <div className="provider-options"><label><input type="checkbox" checked={draft.rememberKey} disabled={!!busy} onChange={e => update({ rememberKey: e.target.checked })} />记住密钥，重启后继续使用</label>{state?.keySet && <button className="text-button" disabled={!!busy} onClick={() => { setKey(''); update({ clearKey: true }); }}>清除已保存的密钥</button>}</div>
      <p className="model-note">密钥由本机后台保存，不会从设置接口返回。更换为其他提供方地址后，请重新填写密钥。未勾选记住时，重启服务后需重新填写。</p>
      <label htmlFor="web-model-id">模型 ID</label><input id="web-model-id" list="web-provider-models" value={draft.model} disabled={!!busy} placeholder="填写提供方支持的模型 ID，或先读取模型列表" onChange={e => update({ model: e.target.value })} /><datalist id="web-provider-models">{models.map(model => <option value={model.id} key={model.id} />)}</datalist>
      {!!models.length && <select aria-label="从 API 模型列表选择" value={models.some(m => m.id === draft.model) ? draft.model : ''} disabled={!!busy} onChange={e => update({ model: e.target.value })}><option value="">选择一个模型…</option>{models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}</select>}
      <div className="provider-options"><label><input type="checkbox" checked={draft.stream} disabled={!!busy} onChange={e => update({ stream: e.target.checked })} />流式生成解释</label></div><p className="model-note">支持提供 Chat Completions 接口的兼容服务。先填写基础地址和 Key，再读取模型列表；部分服务需直接填写模型 ID。</p></> : <><div className="codex-provider-copy"><CheckCircle size={24} /><h3>沿用本机 Codex 登录</h3><p>使用已安装的 Codex 及其当前提供方，默认模型遵循阅读器的选择策略。无需在网页中输入 API Key。</p><p>此方式需要本机可用的 Codex 登录；API 接口方式可以独立使用。</p></div><label htmlFor="codex-web-model">Codex 模型 ID（可留空自动选择）</label><input id="codex-web-model" list="codex-web-models" value={draft.model} disabled={!!busy} onChange={e => update({ model: e.target.value })} placeholder="自动选择，或填写当前提供方支持的模型 ID" /><datalist id="codex-web-models">{models.map(model => <option value={model.id} key={model.id} />)}</datalist>{!!models.length && <select aria-label="从 Codex 模型列表选择" value={models.some(m => m.id === draft.model) ? draft.model : ''} disabled={!!busy} onChange={e => update({ model: e.target.value })}><option value="">自动选择</option>{models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}</select>}</>}
      {success && <p className="provider-success" role="status"><CheckCircle size={17} />{success}</p>}{error && <p className="picker-error" role="alert">{error}</p>}
      <p className="model-note">保存后应用到本机网页窗口，取消旧分析并重新生成所需结果。测试连接会发起一次简短模型请求。</p></div>
      <footer className="model-settings-footer provider-footer"><div><button className="project-switch-button" disabled={!!busy || !draft.baseUrl.trim()} onClick={() => void action('models')}>{busy === 'models' ? <CircleNotch size={15} className="spinner" /> : <ArrowClockwise size={15} />}读取模型列表</button><button className="project-switch-button" disabled={!!busy || draft.mode === 'api' && !draft.model.trim()} onClick={() => void action('test')}>{busy === 'test' && <CircleNotch size={15} className="spinner" />}测试连接</button></div><button className="primary-button" disabled={!!busy || draft.mode === 'api' && !draft.model.trim()} onClick={() => void action('save')}>{busy === 'save' && <CircleNotch size={15} className="spinner" />}保存设置</button></footer>
    </div>
  </div>;
}
