import { useEffect, useRef } from 'react';
import { X, PushPin, ArrowUpRight, Sparkle, WarningCircle, CheckCircle, CircleNotch } from '@phosphor-icons/react';
import type { JobView } from '../shared/contracts.js';
import type { CodeSelection } from './CodeEditor.js';

export function ExplanationPanel({ selection, job, error, pinned, onPin, onClose, onExplain, onJump, busy }: {
  selection: CodeSelection | null; job: JobView | null; error: string; pinned: boolean; busy: boolean;
  onPin: () => void; onClose: () => void; onExplain: (question?: string) => void; onJump: (path: string, line: number) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose]);
  if (!selection && !job && !error) return null;
  const explanation = job?.explanation;
  const width = Math.min(390, window.innerWidth - 24);
  const x = pinned ? window.innerWidth - width - 16 : Math.max(12, Math.min((selection?.anchor.x ?? 380) + 22, window.innerWidth - width - 16));
  const y = pinned ? 136 : Math.max(136, Math.min((selection?.anchor.y ?? 144) + 12, window.innerHeight - 340));
  return <aside ref={panel} className={`explanation-panel ${pinned ? 'pinned' : ''}`} role="region" aria-label="选区解释" style={{ left: x, top: y, width, maxHeight: `calc(100dvh - ${y + 16}px)` }}>
    <header className="popup-header">
      <span className="popup-mark"><Sparkle size={17} weight="duotone" /></span>
      <div className="popup-title"><strong>读懂这一段</strong><span>第 {job?.startLine ?? selection?.startLine}–{job?.endLine ?? selection?.endLine} 行</span></div>
      <button className={`icon-button ${pinned ? 'active' : ''}`} title={pinned ? '取消固定' : '固定到右侧'} aria-label={pinned ? '取消固定' : '固定到右侧'} onClick={onPin}><PushPin size={17} weight={pinned ? 'fill' : 'regular'} /></button>
      <button className="icon-button" aria-label="关闭解释" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="popup-content" aria-live="polite">
      {error && <div className="inline-error"><WarningCircle size={18} /><span>{error}</span></div>}
      {busy && <div className="explanation-loading"><div className="loading-label"><CircleNotch className="spinner" size={17} /><span>后台正在解释</span></div>{job?.preview && <p className="stream-summary">{job.preview}</p>}<div className="skeleton long" /><div className="skeleton" /><div className="skeleton short" /><p>结果直接显示在此处，可继续阅读其他代码。</p></div>}
      {!busy && !explanation && !error && <div className="popup-ready"><p>后台将结合项目背景和相关源码，解释用途、执行逻辑及审查要点。</p><button className="primary-button" onClick={() => onExplain()}><Sparkle size={16} />解释选区<span className="shortcut">Ctrl ↵</span></button></div>}
      {!busy && job && ['stale', 'failed', 'cancelled'].includes(job.status) && <p className="muted-copy">{job.error ?? '本次浮窗请求已取消。'}</p>}
      {explanation && <>
        <section><div className="eyebrow">这段代码做什么</div><p className="explanation-summary">{explanation.summary}</p></section>
        {(explanation.inputs.length > 0 || explanation.outputs.length > 0) && <div className="io-block"><div><span>输入</span>{explanation.inputs.map((s, i) => <p key={i}>{s}</p>)}</div><div><span>输出</span>{explanation.outputs.map((s, i) => <p key={i}>{s}</p>)}</div></div>}
        {explanation.steps.length > 0 && <section><div className="eyebrow">执行过程</div><ol className="step-list">{explanation.steps.map((step, i) => <li key={i}><span>{String(i + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol></section>}
        {explanation.citations.length > 0 && <section><div className="eyebrow">相关源码</div><div className="source-list">{explanation.citations.map((item, i) => <button key={i} onClick={() => onJump(item.path, item.line)}><div><code>{item.path}:{item.line}</code><span>{item.description}</span></div><ArrowUpRight size={16} /></button>)}</div></section>}
        {explanation.cautions.length > 0 && <section><div className="eyebrow">审查时留意</div>{explanation.cautions.map((item, i) => <div className={`caution ${item.kind}`} key={i}>{item.kind === 'confirmed' ? <CheckCircle size={16} /> : <WarningCircle size={16} />}<p><span>{item.kind === 'confirmed' ? '已确认' : '待验证'}</span>{item.text}</p></div>)}</section>}
        <details className="coverage"><summary>本次解释依据</summary><p>{explanation.coverage}</p></details>
      </>}
    </div>
    {explanation && <footer className="popup-footer"><span className="context-indicator"><i />{job?.cached ? '已复用缓存' : `后台解释 · ${((job?.elapsedMs ?? 0) / 1000).toFixed(1)} 秒`}</span><button className="text-button" disabled={busy} onClick={() => onExplain('请用一个具体的输入和输出示例，逐步解释这段代码。')}>举个例子<ArrowUpRight size={14} /></button></footer>}
  </aside>;
}
