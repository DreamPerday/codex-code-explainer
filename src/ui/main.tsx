import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Code, FolderOpen, MagnifyingGlass, ArrowClockwise, Sparkle, CaretRight, FileCode, PlugsConnected, WarningCircle, SidebarSimple, CircleNotch, TreeStructure, ClockCounterClockwise, SlidersHorizontal } from '@phosphor-icons/react';
import { ReaderBridge, type Seed } from './bridge.js';
import { CodeEditor, type CodeSelection } from './CodeEditor.js';
import { ExplanationPanel } from './ExplanationPanel.js';
import { MindMapPanel } from './MindMapPanel.js';
import { ProjectPicker } from './ProjectPicker.js';
import { ModelSettings } from './ModelSettings.js';
import { WebSettings } from './WebSettings.js';
import type { ProviderState } from '../shared/web.js';
import type { FolderLocations } from '../shared/folders.js';
import type { MindNode } from '../shared/mind-map.js';
import type { FileSnapshot, JobView, ProjectInfo, FilePurpose } from '../shared/contracts.js';

const bridge = new ReaderBridge();
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
function Reader() {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [seed, setSeed] = useState<Seed | null>(null);
  const [rootInput, setRootInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [inferenceEpoch, setInferenceEpoch] = useState(0);
  const providerRevision = useRef('');
  const [folderLocations, setFolderLocations] = useState<FolderLocations | null>(null);
  const [filter, setFilter] = useState('');
  const [file, setFile] = useState<FileSnapshot | null>(null);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [popupError, setPopupError] = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [auto, setAuto] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [jump, setJump] = useState<{ line: number; lastLine?: number; serial: number } | null>(null);
  const [mindOpen, setMindOpen] = useState(false);
  const [mindRefresh, setMindRefresh] = useState(0);
  const [purposes, setPurposes] = useState<Record<string, FilePurpose>>({});
  const [purposeBusy, setPurposeBusy] = useState(false);
  const [purposeError, setPurposeError] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [contextInput, setContextInput] = useState('');
  const [contextSaving, setContextSaving] = useState(false);
  const purposePaths = (seed?.project?.files ?? []).filter(p => p.toLowerCase().includes(filter.toLowerCase())).slice(0, 80);
  const purposeKey = purposePaths.join('\n');
  const currentJob = useRef<{ sessionId: string; jobId: string } | null>(null);
  const busyRef = useRef(false);
  const fileRequest = useRef(0);
  const requestSerial = useRef(0);
  const selectedRequest = useRef<{ file: FileSnapshot; selection: CodeSelection } | null>(null);
  const viewState = useRef({ seed, file, selection, inferenceEpoch });
  viewState.current = { seed, file, selection, inferenceEpoch };

  useEffect(() => {
    let disposed = false;
    let queuedSeed: Seed | null = null;
    let ready = false;
    const accept = async (next: Seed) => {
      if (disposed) return;
      if (!ready) { queuedSeed = next; return; }
      setSeed(next);
      setContextInput(next.context ?? '');
      if (next.openedFile) {
        try {
          const connected = await bridge.call<Seed>('connect_open_file', { sessionId: next.sessionId });
          if (!disposed) setSeed(connected);
        } catch (error) { if (!disposed) setError(message(error)); }
      }
    };
    bridge.connect(next => { void accept(next); }).then(() => {
      ready = true;
      if (disposed) return;
      setStatus('connected');
      if (queuedSeed) void accept(queuedSeed);
    }).catch(error => { if (!disposed) { setStatus('error'); setError(message(error)); } });
    return () => { disposed = true; void bridge.close(); };
  }, []);

  useEffect(() => {
    if (!seed) return;
    let disposed = false;
    void bridge.call<FolderLocations>('get_folder_locations', { sessionId: seed.sessionId }).then(value => { if (!disposed) setFolderLocations(value); }).catch(() => {});
    return () => { disposed = true; };
  }, [seed?.sessionId, seed?.project?.root]);

  useEffect(() => {
    if (!seed?.project) return;
    let disposed = false;
    bridge.call<{ purposes: Record<string, FilePurpose> }>('get_file_purposes', { sessionId: seed.sessionId, paths: purposePaths }).then(result => {
      if (!disposed) setPurposes(p => ({ ...p, ...result.purposes }));
    }).catch(error => { if (!disposed) setPurposeError(message(error)); });
    return () => { disposed = true; };
  }, [seed?.sessionId, seed?.project, seed?.context, seed?.model, purposeKey]);

  async function improvePurposes() {
    if (!seed || purposeBusy) return;
    setPurposeBusy(true); setPurposeError('');
    const sessionId = seed.sessionId;
    const paths = purposePaths.filter(p => purposes[p]?.basis !== 'ai');
    try {
      for (let i = 0; i < paths.length; i += 16) {
        if (viewState.current.seed?.sessionId !== sessionId || viewState.current.seed?.project?.root !== seed.project?.root || viewState.current.seed?.model !== seed.model || viewState.current.inferenceEpoch !== inferenceEpoch) break;
        const result = await bridge.call<{ purposes: Record<string, FilePurpose> }>('get_file_purposes', { sessionId, paths: paths.slice(i, i + 16), improve: true });
        if (viewState.current.seed?.sessionId === sessionId && viewState.current.seed?.project?.root === seed.project?.root && viewState.current.seed?.model === seed.model && viewState.current.inferenceEpoch === inferenceEpoch) setPurposes(p => ({ ...p, ...result.purposes }));
      }
    } catch (error) { if (viewState.current.inferenceEpoch === inferenceEpoch) setPurposeError(message(error)); }
    finally { setPurposeBusy(false); }
  }
  async function saveContext() {
    if (!seed) return;
    cancelResult(); setContextSaving(true);
    try {
      await bridge.call('set_reader_context', { sessionId: seed.sessionId, context: contextInput });
      setSeed(s => s ? { ...s, context: contextInput } : s); setContextOpen(false); setJob(null); setShowPopup(false);
    } catch (error) { setError(message(error)); }
    finally { setContextSaving(false); }
  }
  async function saveModel(model: string | null) {
    if (!seed) return;
    await bridge.call('set_reader_model', { sessionId: seed.sessionId, model });
    if (model === (seed.model ?? null)) { setModelOpen(false); return; }
    cancelResult(); setJob(null); setShowPopup(false); setPurposes({}); setPurposeError('');
    setSeed(s => s ? { ...s, model } : s); setModelOpen(false);
  }

  const cancelResult = useCallback(() => {
    requestSerial.current++;
    const active = currentJob.current;
    currentJob.current = null;
    if (active) bridge.call('cancel_explanation', active).catch(error => setError(message(error)));
    busyRef.current = false;
    setBusy(false);
  }, []);
  const acceptProvider = useCallback((next: ProviderState) => {
    bridge.provider = next;
    if (providerRevision.current && providerRevision.current !== next.revision) {
      cancelResult(); setJob(null); setShowPopup(false); setPurposes({}); setPurposeError(''); setPurposeBusy(false);
      setInferenceEpoch(value => value + 1);
      setSeed(value => value ? { ...value, model: null, project: value.project ? { ...value.project } : null } : value);
    }
    providerRevision.current = next.revision;
  }, [cancelResult]);
  useEffect(() => {
    if (!bridge.standalone || status !== 'connected') return;
    if (bridge.provider) acceptProvider(bridge.provider);
    let stopped = false;
    const timer = setInterval(() => { void bridge.webRequest<ProviderState>('/api/provider').then(next => { if (!stopped) acceptProvider(next); }).catch(() => {}); }, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [status, acceptProvider]);
  const openFile = useCallback(async (path: string, line?: number, preserveExplanation = false, lastLine?: number, expectedVersion?: string) => {
    const state = viewState.current;
    if (!state.seed) return;
    const serial = ++fileRequest.current;
    if (!preserveExplanation) { cancelResult(); setJob(null); setShowPopup(false); selectedRequest.current = null; }
    setLoading(true); setError(''); setSelection(null);
    try {
      const next = await bridge.call<FileSnapshot>('read_file', { sessionId: state.seed.sessionId, path });
      if (serial !== fileRequest.current) return;
      if (expectedVersion && next.version !== expectedVersion) { setFile(next); setJump(null); setMindRefresh(v => v + 1); throw new Error('源码已变化，导图正在刷新。请再次点击目标节点。'); }
      setFile(next); setJump(line ? { line, lastLine, serial: Date.now() } : null);
    } catch (error) { if (serial === fileRequest.current) setError(message(error)); }
    finally { if (serial === fileRequest.current) setLoading(false); }
  }, [cancelResult]);
  const navigateMind = useCallback(async (node: MindNode) => {
    if (node.path && node.line) await openFile(node.path, node.line, false, node.kind === 'file' ? node.line : node.endLine, node.sourceVersion);
  }, [openFile]);
  useEffect(() => {
    if (seed?.initialFile) void openFile(seed.initialFile);
  }, [seed?.initialFile, openFile]);

  async function connectProject(root: string) {
    if (!seed) return;
    cancelResult(); fileRequest.current++; setLoading(true); setError('');
    try {
      const next = await bridge.call<Seed>('connect_project', { sessionId: seed.sessionId, root: root.trim() });
      setFile(null); setJob(null); setSelection(null); setShowPopup(false); setPurposes({}); setPurposeError('');
      setJump(null); setFilter(''); setMindOpen(false); selectedRequest.current = null;
      setSeed(next); setRootInput(next.project?.root ?? root); setPickerOpen(false); setSidebar(true);
    }
    finally { setLoading(false); }
  }
  async function refresh() {
    if (!seed) return;
    try {
      const project = await bridge.call<ProjectInfo>('list_project_files', { sessionId: seed.sessionId });
      setSeed(previous => previous ? { ...previous, project } : previous);
      setMindRefresh(v => v + 1);
      if (file) await openFile(file.path);
    } catch (error) { setError(message(error)); }
  }

  const explain = useCallback(async (question?: string) => {
    const state = viewState.current;
    const chosen = question && selectedRequest.current ? selectedRequest.current : (state.file && state.selection ? { file: state.file, selection: state.selection } : null);
    if (!state.seed || !chosen || busyRef.current) return;
    selectedRequest.current = chosen;
    busyRef.current = true; setBusy(true); setShowPopup(true); setPopupError(''); setJob(null);
    const serial = ++requestSerial.current;
    let pending: JobView | null = null;
    try {
      pending = await bridge.call<JobView>('request_explanation', {
        sessionId: state.seed.sessionId, path: chosen.file.path, version: chosen.file.version,
        from: chosen.selection.from, to: chosen.selection.to,
        question: question ?? '解释这段代码的业务作用、输入输出、执行过程和需要审查的地方。',
      });
      if (serial !== requestSerial.current) { await bridge.call('cancel_explanation', { sessionId: state.seed.sessionId, jobId: pending.id }); return; }
      currentJob.current = { sessionId: state.seed.sessionId, jobId: pending.id };
      setJob(pending);
    } catch (error) {
      if (serial !== requestSerial.current) return;
      if (pending) await bridge.call('cancel_explanation', { sessionId: state.seed.sessionId, jobId: pending.id }).catch(() => undefined);
      currentJob.current = null; busyRef.current = false; setBusy(false); setPopupError(message(error));
    }
  }, []);

  useEffect(() => {
    if (!busy || !job || !seed) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await bridge.call<JobView>('get_explanation', { sessionId: seed.sessionId, jobId: job.id });
        if (disposed || currentJob.current?.jobId !== job.id) return;
        setJob(result);
        if (result.status !== 'pending') {
          currentJob.current = null; busyRef.current = false; setBusy(false); setJob(result);
          return;
        }
        timer = setTimeout(poll, 450);
      } catch (error) {
        if (!disposed) { currentJob.current = null; busyRef.current = false; setBusy(false); setPopupError(message(error)); }
      }
    };
    timer = setTimeout(poll, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [busy, job?.id, seed?.sessionId]);

  useEffect(() => {
    if (!showPopup || job?.status !== 'complete' || !seed) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const checkVersion = async () => {
      try {
        const result = await bridge.call<JobView>('get_explanation', { sessionId: seed.sessionId, jobId: job.id });
        if (disposed) return;
        if (result.status !== 'complete') { setJob(result); return; }
        timer = setTimeout(checkVersion, 3500);
      } catch (error) { if (!disposed) setPopupError(message(error)); }
    };
    timer = setTimeout(checkVersion, 3500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [showPopup, job?.status, job?.id, seed?.sessionId]);

  useEffect(() => {
    if (!auto || !selection?.user || !file || busyRef.current) return;
    if (!file.text.slice(selection.from, selection.to).trim()) return;
    const serial = requestSerial.current;
    const timer = setTimeout(() => { if (serial === requestSerial.current) void explain(); }, 400);
    return () => clearTimeout(timer);
  }, [selection, auto, file, explain]);

  const handleSelection = useCallback((next: CodeSelection | null) => {
    if (next?.user && busyRef.current) cancelResult();
    setSelection(next);
    if (next?.user) { selectedRequest.current = null; setShowPopup(true); setJob(null); setPopupError(''); }
  }, [cancelResult]);
  const closePopup = useCallback(() => { setShowPopup(false); cancelResult(); }, [cancelResult]);
  const files = (seed?.project?.files ?? []).filter(path => path.toLowerCase().includes(filter.toLowerCase()));
  const visibleFiles = files.slice(0, 80);
  const folderLabel = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '项目根目录';
  let previousFolder = '';

  return <main className="reader-app min-h-[100dvh]">
    <header className="app-header"><div className="wordmark"><span className="logo-mark"><Code size={22} weight="bold" /></span><div><strong>代码随读</strong><span>理解代码，再做判断</span></div></div><div className="header-actions">{status === 'connected' && seed && <><button className="project-switch-button model-switch-button" aria-label={bridge.standalone ? '模型与 API' : '解释模型'} title={seed.model ? `当前模型：${seed.model}` : '选择模型和连接方式'} onClick={() => setModelOpen(true)}><SlidersHorizontal size={16} /><span>{bridge.standalone ? '模型与 API' : seed.model || '解释模型'}</span></button><button className="project-switch-button" disabled={loading} onClick={() => setPickerOpen(true)}><FolderOpen size={16} />{seed.project ? '切换项目' : '选择文件夹'}</button></>}<div className="header-status"><i className={status === 'connected' ? 'connected' : ''} /><span>{status === 'connecting' ? '正在连接后台' : status === 'error' ? '连接不可用' : bridge.standalone ? '独立网页版' : '独立后台模式'}</span></div></div></header>
    {error && <div className="error-banner" role="alert"><WarningCircle size={18} /><span>{error}</span></div>}
    {status === 'connecting' && <div className="connection-state"><CircleNotch size={28} className="spinner" /><p>正在连接代码阅读面板…</p></div>}
    {status === 'error' && <div className="connection-state"><PlugsConnected size={36} /><h1>{bridge.standalone ? '本机后台暂不可用' : '需要从 Codex 插件中打开'}</h1><p>{bridge.standalone ? '请确认代码随读的本机服务正在运行，然后刷新页面。' : '安装“代码随读”后，在聊天中调用一次“打开代码阅读面板”。之后选中代码即可在这里查看解释。'}</p></div>}
    {status === 'connected' && !seed && <div className="connection-state"><CircleNotch size={24} className="spinner" /><p>等待客户端提供阅读会话…</p></div>}
    {status === 'connected' && seed && !seed.project && <div className="welcome"><div className="welcome-icon"><FolderOpen size={32} weight="duotone" /></div><span className="eyebrow">从一个项目开始</span><h1>让每一段代码<br />都有来龙去脉。</h1><p>打开项目，选中你想理解的代码。解释由{bridge.standalone ? '本机' : '插件'}后台直接生成，并附带相关源码依据。</p>
      <button className="primary-button welcome-browse" disabled={loading} onClick={() => setPickerOpen(true)}><FolderOpen size={18} />浏览文件夹<CaretRight size={16} /></button>
      <details className="manual-project-path"><summary>直接粘贴路径</summary><form onSubmit={event => { event.preventDefault(); void connectProject(rootInput).catch(error => setError(message(error))); }}><label htmlFor="project-root">项目文件夹</label><div className="root-input"><input id="project-root" value={rootInput} onChange={e => setRootInput(e.target.value)} placeholder="例如 E:\\projects\\my-app" required /><button className="primary-button" disabled={loading || !rootInput.trim()}>{loading ? '正在打开' : '打开项目'}<CaretRight size={16} /></button></div></form></details>
      {!!folderLocations?.recents.length && <section className="welcome-recents" aria-label="最近打开的项目"><h2>最近打开</h2>{folderLocations.recents.slice(0, 4).map(project => <button key={project.path} disabled={loading} title={project.path} onClick={() => void connectProject(project.path).catch(error => setError(message(error)))}><ClockCounterClockwise size={18} /><span><strong>{project.name}</strong><small>{project.path}</small></span><CaretRight size={14} /></button>)}</section>}
      <div className="welcome-note"><PlugsConnected size={15} /><span>{bridge.standalone ? '只读本机源码 · API 或 Codex · 模型与 API 在右上角设置' : '插件后台独立解释 · 只读源码 · 使用本机 Codex 登录'}</span></div></div>}
    {seed?.project && <div className={`workspace ${sidebar ? '' : 'hide-sidebar'}`}>
      <aside className="file-sidebar"><div className="project-heading"><FolderOpen size={18} /><strong title={seed.project.root}>{seed.project.name}</strong><button className="icon-button" aria-label="刷新项目" onClick={() => void refresh()}><ArrowClockwise size={16} /></button></div><div className="file-search"><MagnifyingGlass size={16} /><input aria-label="搜索文件" placeholder="搜索文件…" value={filter} onChange={e => setFilter(e.target.value)} /></div><div className="purpose-toolbar"><span>文件用途</span><button className="text-button" disabled={purposeBusy} onClick={() => void improvePurposes()}>{purposeBusy ? <><CircleNotch size={12} className="spinner" />正在补全</> : <><Sparkle size={12} />AI 完善用途</>}</button></div>{purposeError && <p className="purpose-error" role="alert">{purposeError}</p>}<div className="file-list">{visibleFiles.map(path => {
        const folder = folderLabel(path); const showGroup = folder !== previousFolder; previousFolder = folder;
        return <div key={path}>{showGroup && <div className="folder-label" title={folder}>{folder}</div>}<button className={`file-item ${file?.path === path ? 'selected' : ''}`} onClick={() => void openFile(path)} title={path}><FileCode size={16} /><span className="file-text"><span className="file-name">{path.split('/').at(-1)}</span><span className="file-purpose" title={purposes[path] ? `${purposes[path].text}（${purposes[path].basis === 'ai' ? 'AI 源码摘要' : purposes[path].basis === 'source' ? '源码注释' : '结构提示，待 AI 完善'}）` : ''}>{purposes[path]?.text ?? '正在读取用途…'}{purposes[path]?.basis === 'ai' && <em>AI</em>}</span></span></button></div>;
      })}{files.length === 0 && <p className="no-files">{filter ? '没有匹配的文件' : '项目中没有可阅读的源码文件'}</p>}{files.length > 80 && <p className="list-limit">还有 {files.length - 80} 个文件，请搜索定位。</p>}</div><footer className="sidebar-footer"><span>{seed.project.files.length} 个源码文件{seed.project.truncated ? '（部分）' : ''}</span><span>只读</span></footer></aside>
      <section className="code-pane"><div className="code-toolbar"><button className="icon-button" aria-label="切换文件列表" onClick={() => setSidebar(v => !v)}><SidebarSimple size={18} /></button><div className="file-breadcrumb" title={file?.path}>{file ? <><span>{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) + ' / ' : ''}</span><strong>{file.path.split('/').at(-1)}</strong></> : '选择一个文件开始阅读'}</div><button className={`text-button mind-open-button ${mindOpen ? "active" : ""}`} aria-label="代码思维导图" aria-pressed={mindOpen} onClick={() => setMindOpen(v => !v)}><TreeStructure size={16} /><span>代码导图</span></button><button className="text-button context-button" onClick={() => setContextOpen(v => !v)}>项目背景{seed.context ? ' · 已附带' : ''}</button><label className="auto-toggle"><input type="checkbox" aria-label="自动解释" checked={auto} onChange={e => setAuto(e.target.checked)} /><span>自动解释</span></label><button className="explain-button" aria-label="解释选区" title="解释选区（Ctrl+Enter）" disabled={!selection || busy} onClick={() => void explain()}><Sparkle size={15} /><span>解释选区</span></button></div>
        {mindOpen && seed.project && <MindMapPanel key={seed.sessionId + seed.project.root + (seed.model ?? '') + inferenceEpoch} bridge={bridge} sessionId={seed.sessionId} root={seed.project.root} context={seed.context ?? ''} activeFile={file?.path} activeVersion={file?.version} refreshKey={mindRefresh} onClose={() => setMindOpen(false)} onNavigate={navigateMind} />}
        {contextOpen && <div className="context-editor"><label htmlFor="project-context">解释时使用的项目背景</label><p>打开面板时可附带当前聊天的背景摘要。后续聊天不会自动同步，可在这里补充。</p><textarea id="project-context" value={contextInput} maxLength={8000} onChange={e => setContextInput(e.target.value)} placeholder="例如：这是一个登录模块，我重点关注权限校验和错误处理。" /><button className="primary-button" disabled={contextSaving} onClick={() => void saveContext()}>{contextSaving ? '保存中' : '保存背景'}</button></div>}<div className="editor-region">{loading && <div className="file-loading"><CircleNotch className="spinner" size={22} /><span>正在读取文件…</span></div>}{file ? <CodeEditor file={file} onSelection={handleSelection} onExplain={() => void explain()} jump={jump} /> : <div className="editor-empty"><span className="empty-brackets"><Code size={52} weight="thin" /></span><h2>从好奇的那一段开始</h2><p>在左侧打开文件，拖动选中代码。<br />松开后稍等，解释会出现在选区旁。</p><div className="empty-flow"><span>选择代码</span><CaretRight size={12} /><span>结合上下文</span><CaretRight size={12} /><span>查看解释</span></div></div>}</div>
        <footer className="editor-footer"><span>{selection ? `已选第 ${selection.startLine}–${selection.endLine} 行 · ${selection.to - selection.from} 个字符` : file ? `${file.lineCount} 行 · UTF-8` : '选择文件后即可阅读'}</span><span>{busy ? 'Codex 正在解释选区' : 'Ctrl + Enter 解释选区'}</span></footer>
      </section>
    </div>}
    {showPopup && <ExplanationPanel selection={selectedRequest.current && job ? selectedRequest.current.selection : selection} job={job} error={popupError} pinned={pinned} busy={busy} onPin={() => setPinned(v => !v)} onClose={closePopup} onExplain={question => void explain(question)} onJump={(path, line) => { setPinned(true); void openFile(path, line, true); }} />}
    {pickerOpen && seed && <ProjectPicker bridge={bridge} sessionId={seed.sessionId} initialPath={seed.project?.root} onClose={() => setPickerOpen(false)} onOpen={connectProject} />}
    {modelOpen && seed && (bridge.standalone ? <WebSettings bridge={bridge} onClose={() => setModelOpen(false)} onSaved={next => { acceptProvider(next); setModelOpen(false); }} /> : <ModelSettings bridge={bridge} sessionId={seed.sessionId} model={seed.model} onClose={() => setModelOpen(false)} onSave={saveModel} />)}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Reader />);
