import { useEffect, useRef, useState } from 'react';
import { CircleNotch, SlidersHorizontal, X } from '@phosphor-icons/react';
import type { ReaderModelSettings } from '../shared/models.js';
import type { ReaderBridge } from './bridge.js';

export function ModelSettings({ bridge, sessionId, model, onClose, onSave }: { bridge: ReaderBridge; sessionId: string; model?: string | null; onClose: () => void; onSave: (model: string | null) => Promise<void> }) {
  const [catalog, setCatalog] = useState<ReaderModelSettings | null>(null);
  const [choice, setChoice] = useState(model ? 'custom' : '');
  const [custom, setCustom] = useState(model ?? '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const changed = useRef(false);
  useEffect(() => {
    let disposed = false;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    void bridge.call<ReaderModelSettings>('get_reader_models', { sessionId }).then(value => {
      if (disposed) return; setCatalog(value);
      if (!changed.current && model && value.models.some(m => m.id === model)) setChoice(model);
    }).catch(e => { if (!disposed) setError(e instanceof Error ? e.message : '模型列表读取失败，可填写模型名。'); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; previous?.focus(); };
  }, [bridge, sessionId]);
  const value = choice === 'custom' ? custom.trim() : choice;
  async function save() {
    setSaving(true); setError('');
    try { await onSave(value || null); } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试。'); setSaving(false); }
  }
  return <div className="project-picker-backdrop" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
    <div className="model-settings" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="model-title" onKeyDown={e => {
      if (e.key === 'Escape' && !saving) { e.preventDefault(); onClose(); }
      if (e.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? [])];
      if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
    }}>
      <header className="picker-heading"><div><SlidersHorizontal size={24} /><div><h2 id="model-title">解释模型</h2><p>选区解释、文件用途和导图总结使用同一选择。</p></div></div><button className="icon-button" aria-label="关闭模型设置" disabled={saving} onClick={onClose}><X size={20} /></button></header>
      <div className="model-settings-body"><label htmlFor="reader-model">选择模型</label><select id="reader-model" value={choice} disabled={saving} onChange={e => { changed.current = true; setChoice(e.target.value); }}>
        <option value="">自动选择{catalog?.defaultModel ? ` · ${catalog.defaultModel}` : '（阅读器默认）'}</option>
        {catalog?.models.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}
        <option value="custom">填写自定义模型名…</option>
      </select>
      {choice === 'custom' && <><label htmlFor="custom-reader-model">模型名</label><input id="custom-reader-model" autoComplete="off" value={custom} maxLength={200} disabled={saving} placeholder="填写提供方实际支持的模型 ID" onChange={e => { changed.current = true; setCustom(e.target.value); }} /></>}
      {loading && <p className="model-note"><CircleNotch className="spinner" size={14} />正在读取 Codex 模型列表…</p>}
      {catalog && <p className="model-note">当前提供方：<strong>{catalog.provider}</strong>{catalog.configuredModel && <> · Codex 配置：{catalog.configuredModel}</>}</p>}
      <p className="model-note">沿用现有 Codex 登录和提供方。列表来自 Codex；自定义提供方可能仅支持其中一部分模型，也可以直接填写它提供的模型 ID。</p>
      <p className="model-note">切换后取消当前分析，重新生成所需解释。设置用于当前面板，并作为新面板的默认选择。</p>
      {error && <p className="picker-error" role="alert">{error}</p>}</div>
      <footer className="model-settings-footer"><button className="primary-button" disabled={saving || choice === 'custom' && !value} onClick={() => void save()}>{saving && <CircleNotch className="spinner" size={16} />}{saving ? '保存中…' : '保存模型选择'}</button></footer>
    </div>
  </div>;
}
