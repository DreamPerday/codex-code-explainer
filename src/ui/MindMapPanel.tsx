import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TreeStructure, X, PushPin, ArrowsOutSimple, ArrowsOut, ArrowsIn, Minus, Plus, MagnifyingGlass, ArrowClockwise, Sparkle, CircleNotch, CaretRight, CaretDown, ArrowUpRight, Crosshair, SidebarSimple } from '@phosphor-icons/react';
import type { MindMap, MindNode, MindKind, MindJob, Architecture } from '../shared/mind-map.js';
import type { ReaderBridge } from './bridge.js';
import { expandAncestors, mindLayout } from './mind-layout.js';

const kindLabel: Record<MindKind, string> = { project: '项目', directory: '目录', file: '文件', class: '类', function: '函数', method: '方法', interface: '接口', type: '类型', property: '成员', enum: '枚举' };
const errorMessage = (e: unknown) => e instanceof Error ? e.message : '导图操作失败，请重试。';
type Props = { bridge: ReaderBridge; sessionId: string; root: string; context: string; activeFile?: string; activeVersion?: string; refreshKey: number; onClose: () => void; onNavigate: (node: MindNode) => Promise<void> };
type ViewMode = 'docked' | 'floating' | 'fullscreen';
function savedView(): { mode: ViewMode; zoom: number; font: number } {
  try {
    const value = JSON.parse(localStorage.getItem('code-explainer.mind-view') ?? '{}');
    return { mode: ['docked', 'floating', 'fullscreen'].includes(value.mode) ? value.mode : 'docked', zoom: Number.isFinite(value.zoom) ? Math.min(3, Math.max(.5, value.zoom)) : 1, font: [14, 16, 18].includes(value.font) ? value.font : 14 };
  } catch { return { mode: 'docked', zoom: 1, font: 14 }; }
}

export function MindMapPanel({ bridge, sessionId, root, context, activeFile, activeVersion, refreshKey, onClose, onNavigate }: Props) {
  const [map, setMap] = useState<MindMap | null>(null);
  const [mode, setMode] = useState<ViewMode>(() => savedView().mode);
  const [collapsed, setCollapsed] = useState(false);
  const [details, setDetails] = useState(true);
  const [scope, setScope] = useState<'project' | 'file'>('project');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState('project');
  const [zoom, setZoom] = useState(() => savedView().zoom);
  const [font, setFont] = useState(() => savedView().font);
  const previousMode = useRef<ViewMode>('docked');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [job, setJob] = useState<MindJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [scopedArchitecture, setScopedArchitecture] = useState<{ id: string; value: Architecture } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const requestSerial = useRef(0);
  const activeJob = useRef<string | null>(null);
  const summaryNode = useRef('project');
  const summaryVersion = useRef('');
  const mapVersion = useRef('');
  const panel = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const disposed = useRef(false);
  useEffect(() => { try { localStorage.setItem('code-explainer.mind-view', JSON.stringify({ mode, zoom, font })); } catch { /* Host may disable storage. */ } }, [mode, zoom, font]);
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) { event.preventDefault(); changeMode(previousMode.current); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [mode]);

  const load = useCallback(async () => {
    const serial = ++requestSerial.current;
    setLoading(true); setError('');
    try {
      const { map: next } = await bridge.call<{ map: MindMap }>('get_mind_map', { sessionId });
      if (serial !== requestSerial.current || disposed.current) return;
      if (!mapVersion.current) setFocusId(next.rootId);
      if (mapVersion.current && mapVersion.current !== next.version) { setScopedArchitecture(null); setJob(null); activeJob.current = null; }
      mapVersion.current = next.version;
      setExpanded(previous => previous.size ? previous : new Set(next.nodes.filter(n => n.kind === 'project' || n.kind === 'directory' && !n.qualifiedName.includes('/')).map(n => n.id)));
      setMap(next);
      setSelected(current => next.nodes.some(n => n.id === current) ? current : next.rootId);
    } catch (e) { if (!disposed.current && serial === requestSerial.current) setError(errorMessage(e)); }
    finally { if (!disposed.current && serial === requestSerial.current) setLoading(false); }
  }, [bridge, sessionId]);
  useEffect(() => { disposed.current = false; void load(); return () => { disposed.current = true; requestSerial.current++; stopDrag.current?.(); const id = activeJob.current; if (id) void bridge.call('cancel_mind_summary', { sessionId, jobId: id }).catch(() => {}); }; }, [load, sessionId]);
  useEffect(() => { if (map) void load(); }, [context, refreshKey, activeVersion]);

  useEffect(() => {
    if (!job || job.status !== 'pending') return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await bridge.call<MindJob>('get_mind_summary', { sessionId, jobId: job.id });
        if (stopped || summaryVersion.current !== mapVersion.current) return;
        setJob(next);
        if (['pending', 'complete'].includes(next.status) && next.analyses.length) setMap(previous => previous ? { ...previous, nodes: previous.nodes.map(n => ({ ...n, analysis: next.analyses.find(a => a.id === n.id) ?? n.analysis })) } : previous);
        if (['pending', 'complete'].includes(next.status) && next.architecture) {
          setScopedArchitecture({ id: summaryNode.current, value: next.architecture });
          if (summaryNode.current === 'project') setMap(previous => previous ? { ...previous, architecture: next.architecture } : previous);
        }
        if (next.status === 'pending') timer = setTimeout(poll, 700);
        else { activeJob.current = null; if (next.error) setError(next.error); }
      } catch (e) { if (!stopped) { activeJob.current = null; setError(errorMessage(e)); setJob(null); } }
    };
    timer = setTimeout(poll, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, job?.status, bridge, sessionId]);

  const byId = useMemo(() => new Map(map?.nodes.map(n => [n.id, n]) ?? []), [map]);
  const currentFile = map?.nodes.find(n => n.kind === 'file' && n.path === activeFile);
  const mapRoot = scope === 'file' && currentFile ? currentFile.id : map?.rootId ?? 'project';
  const layout = useMemo(() => mindLayout(map?.nodes ?? [], mapRoot, expanded, query, 350, font / 14), [map, mapRoot, expanded, query, font]);
  const node = byId.get(selected);
  const architecture = scopedArchitecture?.id === selected ? scopedArchitecture.value : selected === 'project' ? map?.architecture : undefined;
  const busy = starting || job?.status === 'pending';

  useEffect(() => {
    if (!focusId || !layout.positions.some(p => p.node.id === focusId)) return;
    const position = layout.positions.find(p => p.node.id === focusId)!;
    const view = viewport.current;
    if (view) view.scrollTo({ left: Math.max(0, (position.x + layout.nodeWidth / 2) * zoom - view.clientWidth / 2), top: Math.max(0, (position.y + layout.nodeHeight / 2) * zoom - view.clientHeight / 2) });
    setFocusId(null);
  }, [focusId, layout, zoom, mode, details]);
  useEffect(() => { setFocusId(selected); }, [zoom, font, mode, details]);
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const observer = new ResizeObserver(() => setFocusId(selected)); observer.observe(view);
    return () => observer.disconnect();
  }, [selected, collapsed]);

  const choose = async (next: MindNode) => {
    setSelected(next.id); setDetails(true);
    if (next.path && next.line) { try { await onNavigate(next); if (mode === 'fullscreen') changeMode('docked'); } catch (e) { setError(errorMessage(e)); } }
  };
  const focus = (id: string) => {
    if (!map) return;
    setExpanded(previous => expandAncestors(map.nodes, id, previous)); setSelected(id); setQuery('');
    if (byId.get(id)?.path !== activeFile) setScope('project');
    setFocusId(id);
  };
  async function summarize() {
    if (!map || !node || busy) return;
    setStarting(true); setError(''); summaryNode.current = node.id; summaryVersion.current = map.version;
    try {
      const next = await bridge.call<MindJob>('start_mind_summary', { sessionId, nodeId: node.id, version: map.version });
      if (disposed.current) { void bridge.call('cancel_mind_summary', { sessionId, jobId: next.id }).catch(() => {}); return; }
      activeJob.current = next.id; setJob(next);
    } catch (e) { if (!disposed.current) setError(errorMessage(e)); }
    finally { if (!disposed.current) setStarting(false); }
  }
  async function cancel() { if (!activeJob.current) return; const id = activeJob.current; activeJob.current = null; await bridge.call('cancel_mind_summary', { sessionId, jobId: id }).catch(e => setError(errorMessage(e))); setJob(previous => previous ? { ...previous, status: 'cancelled' } : null); }
  function changeMode(next: ViewMode) {
    if (next === 'fullscreen') { previousMode.current = mode === 'fullscreen' ? 'docked' : mode; setCollapsed(false); }
    setMode(next); stopDrag.current?.();
    for (const property of ['left', 'top', 'right', 'width', 'height']) panel.current?.style.removeProperty(property);
  }
  function dragWindow(e: React.PointerEvent) {
    if (mode !== 'floating' || e.button !== 0 || (e.target as HTMLElement).closest('button') || !panel.current) return;
    e.preventDefault(); const element = panel.current; const rect = element.getBoundingClientRect(); const origin = { x: e.clientX, y: e.clientY };
    const move = (event: PointerEvent) => { element.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, rect.left + event.clientX - origin.x))}px`; element.style.top = `${Math.max(8, Math.min(innerHeight - 48, rect.top + event.clientY - origin.y))}px`; element.style.right = 'auto'; };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); stopDrag.current = null; };
    stopDrag.current?.(); stopDrag.current = stop; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true });
  }
  function pan(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('button') || e.button !== 0 || !viewport.current) return;
    const scroll = viewport.current; const origin = { x: e.clientX, y: e.clientY, left: scroll.scrollLeft, top: scroll.scrollTop }; scroll.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => { scroll.scrollLeft = origin.left - event.clientX + origin.x; scroll.scrollTop = origin.top - event.clientY + origin.y; };
    const stop = () => { scroll.removeEventListener('pointermove', move); scroll.removeEventListener('pointerup', stop); scroll.removeEventListener('lostpointercapture', stop); };
    scroll.addEventListener('pointermove', move); scroll.addEventListener('pointerup', stop, { once: true }); scroll.addEventListener('lostpointercapture', stop, { once: true });
  }
  const connected = map?.edges.filter(e => e.from === selected || e.to === selected) ?? [];
  return <section ref={panel} className={`mind-panel ${mode} ${collapsed ? 'collapsed' : ''} ${details ? 'with-details' : ''}`} style={{ '--mind-font': `${font}px` } as React.CSSProperties} aria-label="代码思维导图" data-mode={mode}>
    <header className="mind-header" onPointerDown={dragWindow}><div className="mind-title"><TreeStructure size={17} /><strong>代码导图</strong><span>{map ? `${map.coverage.indexedFiles} 个文件 · ${map.coverage.symbols} 个符号` : '正在读取结构'}</span></div><div className="mind-window-actions">
      <button className={`icon-button ${mode === 'docked' ? 'active' : ''}`} aria-label="顶部固定" title="在源码上方固定，编辑器独立滚动" onClick={() => changeMode('docked')}><PushPin size={16} /></button>
      <button className={`icon-button ${mode === 'floating' ? 'active' : ''}`} aria-label="悬浮置顶" title="在阅读器内悬浮，可拖动标题栏和调整大小" onClick={() => changeMode('floating')}><ArrowsOutSimple size={16} /></button>
      <button className={`icon-button ${mode === 'fullscreen' ? 'active' : ''}`} aria-label={mode === 'fullscreen' ? '退出导图全屏' : '全屏阅读导图'} title="占满阅读器，按 Esc 退出；点击函数可返回源码" onClick={() => changeMode(mode === 'fullscreen' ? previousMode.current : 'fullscreen')}>{mode === 'fullscreen' ? <ArrowsIn size={17} /> : <ArrowsOut size={17} />}</button>
      <button className="icon-button" aria-label={collapsed ? '展开导图' : '收起导图'} onClick={() => setCollapsed(v => !v)}>{collapsed ? <CaretDown size={17} /> : <Minus size={17} />}</button>
      <button className="icon-button" aria-label="关闭导图" onClick={onClose}><X size={17} /></button>
    </div></header>
    {!collapsed && <><div className="mind-controls"><div className="mind-scope"><button aria-pressed={scope === 'project'} onClick={() => { setScope('project'); if (map) focus(map.rootId); }}>项目框架</button><button aria-pressed={scope === 'file'} disabled={!currentFile} onClick={() => { setScope('file'); if (currentFile && map) { setExpanded(new Set(map.nodes.filter(n => n.path === currentFile.path).map(n => n.id))); focus(currentFile.id); } }}>当前文件</button></div><div className="mind-search"><MagnifyingGlass size={13} /><input aria-label="搜索导图节点" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索类、函数、模块…" /></div><button className="icon-button" aria-label="刷新导图" disabled={loading} onClick={() => void load()}><ArrowClockwise size={15} className={loading ? 'spinner' : ''} /></button><button className="icon-button" aria-label="切换节点详情" onClick={() => setDetails(v => !v)}><SidebarSimple size={16} /></button></div>
      {error && <div className="mind-error" role="alert">{error}<button className="text-button" onClick={() => { setError(''); void load(); }}>刷新</button></div>}
      <div className="mind-body"><div className="mind-map-area"><div ref={viewport} className="mind-viewport" onPointerDown={pan} onWheel={e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(z => Math.max(.5, Math.min(3, z - e.deltaY * .002))); } }}>
        {loading && !map ? <div className="mind-empty"><CircleNotch size={22} className="spinner" /><p>正在解析项目结构…</p></div> : !layout.positions.length ? <div className="mind-empty"><p>{query ? '没有匹配的节点，试试函数名或文件名。' : '尚无可展示的源码结构。'}</p></div> : <div className="mind-scroll-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}><div className="mind-canvas" role="group" aria-label="代码结构节点" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
          <svg className="mind-lines" width={layout.width} height={layout.height} aria-hidden="true">{layout.links.map(({ from, to }) => <path key={`${from.node.id}-${to.node.id}`} d={`M${from.x + layout.nodeWidth},${from.y + layout.nodeHeight / 2} C${from.x + layout.nodeWidth + 22},${from.y + layout.nodeHeight / 2} ${to.x - 22},${to.y + layout.nodeHeight / 2} ${to.x},${to.y + layout.nodeHeight / 2}`} />)}{map?.edges.filter(e => e.kind === 'calls' && (e.from === selected || e.to === selected)).map(e => { const a = layout.positions.find(p => p.node.id === e.from); const b = layout.positions.find(p => p.node.id === e.to); return a && b ? <path className="call-link" key={`call-${e.from}-${e.to}`} d={`M${a.x + layout.nodeWidth / 2},${a.y + layout.nodeHeight} C${a.x + layout.nodeWidth / 2},${a.y + layout.nodeHeight + 32} ${b.x + layout.nodeWidth / 2},${b.y + layout.nodeHeight + 32} ${b.x + layout.nodeWidth / 2},${b.y + layout.nodeHeight}`} /> : null; })}</svg>
          {layout.positions.map(({ node: item, x, y, childCount }) => <div className={`mind-node ${item.id === selected ? 'selected' : ''} ${layout.matches.has(item.id) ? 'match' : ''} kind-${item.kind}`} style={{ left: x, top: y, width: layout.nodeWidth, height: layout.nodeHeight }} key={item.id} data-node-id={item.id}>
            <button className="mind-node-main" aria-label={`${kindLabel[item.kind]} ${item.qualifiedName}`} title={item.analysis?.summary ?? item.summary} onClick={() => void choose(item)}><span className="mind-node-top"><span className="mind-kind">{kindLabel[item.kind]}</span><strong>{item.name}</strong>{item.analysis && <i>AI</i>}</span><span className="mind-node-description">{item.analysis?.summary ?? item.summary}</span></button>
            {childCount > 0 && <button className="mind-expand" aria-label={`${expanded.has(item.id) ? '折叠' : '展开'} ${item.qualifiedName}`} aria-expanded={expanded.has(item.id)} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}>{expanded.has(item.id) || query ? <Minus size={11} /> : <Plus size={11} />}<span>{childCount}</span></button>}
          </div>)}
        </div></div>}
      </div><div className="mind-map-tools"><span>{query ? `${layout.matches.size} 个匹配` : '点击名称跳转 · 拖动空白平移' }{layout.truncated ? ' · 分支较多，请搜索定位' : ''}</span><div><label className="mind-font-label">字号<select aria-label="导图字号" value={font} onChange={e => setFont(Number(e.target.value))}><option value={14}>标准 14</option><option value={16}>大字 16</option><option value={18}>特大 18</option></select></label><button className="icon-button" aria-label="缩小导图" disabled={zoom <= .5} onClick={() => setZoom(z => Math.max(.5, z - .1))}><Minus size={15} /></button><button className="text-button" aria-label="重置导图缩放" title="恢复 100%，不自动缩小文字" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button className="icon-button" aria-label="放大导图" disabled={zoom >= 3} onClick={() => setZoom(z => Math.min(3, z + .1))}><Plus size={15} /></button><button className="icon-button" aria-label="定位所选节点" onClick={() => focus(selected)}><Crosshair size={16} /></button></div></div></div>
      {details && node && <aside className="mind-detail" aria-label="导图节点详情"><div className="mind-detail-heading"><span>{kindLabel[node.kind]}</span><button className="icon-button mind-detail-close" aria-label="隐藏节点详情" onClick={() => setDetails(false)}><X size={14} /></button></div><h3>{node.qualifiedName}</h3>
        {node.path && <button className="mind-source" onClick={() => void choose(node)}>{node.path}:{node.line}<ArrowUpRight size={13} /></button>}
        <p className="mind-summary">{node.analysis?.summary ?? architecture?.summary ?? node.summary}</p>
        <button className="primary-button mind-analyze" disabled={busy || loading} onClick={() => void summarize()}>{busy ? <CircleNotch size={14} className="spinner" /> : <Sparkle size={14} />}{busy ? `${summaryNode.current === node.id ? '正在总结' : '正在总结其他分支'} ${job?.completed ?? 0}/${job?.total ?? '…'}` : ['project', 'directory'].includes(node.kind) ? 'AI 总结框架' : ['file', 'class', 'interface'].includes(node.kind) ? 'AI 总结本分支' : 'AI 详细总结'}</button>{busy && <button className="text-button" onClick={() => void cancel()}>取消总结</button>}
        {node.signature && <section><h4>定义签名</h4><code className="mind-signature">{node.signature}</code></section>}
        {!!node.bases?.length && <section><h4>继承 / 实现</h4><p>{node.bases.join('、')}</p></section>}
        <DetailList title={node.analysis ? '输入' : '参数'} values={node.analysis?.inputs ?? node.parameters} />
        <DetailList title={node.analysis ? '输出' : '返回类型 / 表达式'} values={node.analysis?.outputs ?? node.returns} />
        <DetailList title="关键逻辑" values={node.analysis?.steps} numbered />
        <DetailList title="需核实处" values={node.analysis?.cautions} />
        {!!connected.length && <section><h4>相关依赖与调用</h4>{connected.map((edge, i) => { const target = byId.get(edge.from === selected ? edge.to : edge.from); return target ? <button className="mind-relation" key={i} onClick={() => { focus(target.id); void choose(target); }}><span>{edge.kind === 'imports' ? edge.from === selected ? '导入' : '被导入' : edge.kind === 'inherits' ? '继承' : edge.from === selected ? '调用' : '被调用'}</span><strong>{target.qualifiedName}</strong><CaretRight size={12} /></button> : null; })}</section>}
        {!!node.calls?.length && <details className="mind-raw-calls"><summary>源码中的调用名称（含未解析项）</summary><p>{node.calls.join(' · ')}</p></details>}
        {architecture && <><section><h4>模块分层</h4>{architecture.layers.map((layer, i) => <div className="mind-layer" key={i}><strong>{layer.name}</strong><p>{layer.responsibility}</p><div>{layer.nodeIds.map(id => { const target = byId.get(id); return target ? <button key={id} className="text-button" onClick={() => { focus(id); void choose(target); }}>{target.name}<ArrowUpRight size={10} /></button> : null; })}</div></div>)}</section><DetailList title="主要流程" values={architecture.flow} numbered /><section><h4>分析范围</h4><p>{architecture.coverage}</p></section></>}
        <details className="mind-coverage"><summary>结构解析范围{map?.coverage.truncated ? '（部分）' : ''}</summary><p>共 {map?.coverage.totalFiles} 个文件，纳入 {map?.coverage.indexedFiles} 个；其中 {map?.coverage.parsedFiles} 个支持符号解析。</p>{map?.coverage.notes.map((s, i) => <p key={i}>{s}</p>)}{!!map?.coverage.skipped.length && <p>未能读取：{map.coverage.skipped.join('、')}</p>}</details>
      </aside>}
      </div></>}
  </section>;
}
function DetailList({ title, values, numbered = false }: { title: string; values?: string[]; numbered?: boolean }) {
  if (!values?.length) return null;
  return <section><h4>{title}</h4>{numbered ? <ol>{values.map((v, i) => <li key={i}>{v}</li>)}</ol> : <ul>{values.map((v, i) => <li key={i}>{v}</li>)}</ul>}</section>;
}
