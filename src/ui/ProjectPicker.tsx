import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, ArrowClockwise, CaretRight, CircleNotch, ClockCounterClockwise, Desktop, Folder, FolderOpen, HardDrives, House, MagnifyingGlass, Monitor, X, WarningCircle } from '@phosphor-icons/react';
import type { FolderListing, FolderLocation, FolderLocations } from '../shared/folders.js';
import type { ReaderBridge } from './bridge.js';

const message = (error: unknown) => error instanceof Error ? error.message : '无法打开文件夹，请重试。';
type Props = { bridge: ReaderBridge; sessionId: string; initialPath?: string; onClose: () => void; onOpen: (path: string) => Promise<void> };

export function ProjectPicker({ bridge, sessionId, initialPath, onClose, onOpen }: Props) {
  const [locations, setLocations] = useState<FolderLocations | null>(null);
  const [history, setHistory] = useState([initialPath ?? '']);
  const [index, setIndex] = useState(0);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [address, setAddress] = useState(initialPath ?? '');
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState('');
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [native, setNative] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const serial = useRef(0);
  const disposed = useRef(false);
  const nativeRequest = useRef<string | null>(null);
  const addressEdited = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const requested = history[index];

  useEffect(() => {
    disposed.current = false;
    const previous = document.activeElement as HTMLElement | null;
    void bridge.call<FolderLocations>('get_folder_locations', { sessionId }).then(value => { if (!disposed.current) setLocations(value); }).catch(e => { if (!disposed.current) setError(message(e)); });
    dialog.current?.querySelector<HTMLButtonElement>('[aria-label="关闭文件夹选择"]')?.focus();
    return () => {
      disposed.current = true; serial.current++; previous?.focus();
      if (nativeRequest.current) void bridge.call('cancel_folder_picker', { sessionId, requestId: nativeRequest.current }).catch(() => {});
    };
  }, [bridge, sessionId]);

  useEffect(() => {
    const request = ++serial.current; setLoading(true); setBrowseError(''); setSelected(null);
    const timer = setTimeout(() => {
      void bridge.call<FolderListing>('browse_folders', { sessionId, path: requested || undefined, query, showHidden: hidden }).then(value => {
        if (disposed.current || request !== serial.current) return;
        setListing(value); if (!addressEdited.current) setAddress(value.path);
      }).catch(e => { if (!disposed.current && request === serial.current) setBrowseError(message(e)); })
        .finally(() => { if (!disposed.current && request === serial.current) setLoading(false); });
    }, query ? 180 : 0);
    return () => { clearTimeout(timer); serial.current++; };
  }, [bridge, sessionId, requested, index, query, hidden, refresh]);

  const go = useCallback((path: string) => {
    addressEdited.current = false; serial.current++; setLoading(true); setAddress(path);
    setHistory(previous => [...previous.slice(0, index + 1), path]); setIndex(index + 1); setQuery(''); setSelected(null); setError('');
  }, [index]);
  const move = (offset: number) => { addressEdited.current = false; serial.current++; setLoading(true); setAddress(history[index + offset]); setIndex(value => value + offset); setQuery(''); setSelected(null); setError(''); };
  const open = async (path: string) => {
    setOpening(true); setError('');
    try { await onOpen(path); } catch (e) { if (!disposed.current) setError(message(e)); }
    finally { if (!disposed.current) setOpening(false); }
  };
  async function pickNative() {
    if (nativeRequest.current) return;
    const requestId = crypto.randomUUID(); nativeRequest.current = requestId; setNative(true); setError('');
    try {
      const result = await bridge.call<{ path: string | null }>('pick_project_folder', { sessionId, requestId, initialPath: listing?.path }, 310000);
      if (!disposed.current && result.path) await open(result.path);
    } catch (e) { if (!disposed.current) setError(message(e)); }
    finally { nativeRequest.current = null; if (!disposed.current) setNative(false); }
  }
  async function cancelNative() {
    if (!nativeRequest.current) return;
    try { await bridge.call('cancel_folder_picker', { sessionId, requestId: nativeRequest.current }); }
    catch (e) { if (!disposed.current) setError(message(e)); }
  }
  const busy = opening || native;
  function keyboard(event: React.KeyboardEvent) {
    if (event.key === 'Escape' && !opening) { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])].filter(el => el.offsetParent !== null);
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const locationButton = (item: FolderLocation) => <button type="button" key={item.path} className={listing?.path === item.path ? 'current' : ''} title={item.path} disabled={busy} onClick={() => go(item.path)}>
    {item.kind === 'drive' ? <HardDrives size={16} /> : item.kind === 'home' ? <House size={16} /> : item.kind === 'recent' ? <ClockCounterClockwise size={15} /> : item.name.includes('桌面') ? <Desktop size={16} /> : <Folder size={16} />}<span>{item.name}</span>
  </button>;
  return <div className="project-picker-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="project-picker" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title" ref={dialog} onKeyDown={keyboard}>
      <header className="picker-heading"><div><span className="picker-mark"><FolderOpen size={22} /></span><div><h2 id="folder-picker-title">选择项目文件夹</h2><p>浏览目录，或从最近项目继续阅读。</p></div></div><button type="button" className="icon-button" aria-label="关闭文件夹选择" disabled={opening} onClick={onClose}><X size={19} /></button></header>
      <div className="picker-toolbar"><div className="picker-navigation">
        <button type="button" className="icon-button" aria-label="返回上一个文件夹" title="后退" disabled={index === 0 || busy} onClick={() => move(-1)}><ArrowLeft size={16} /></button>
        <button type="button" className="icon-button" aria-label="前进到下一个文件夹" title="前进" disabled={index >= history.length - 1 || busy} onClick={() => move(1)}><ArrowRight size={16} /></button>
        <button type="button" className="icon-button" aria-label="返回上级文件夹" title="上一级" disabled={!listing?.parent || busy} onClick={() => listing?.parent && go(listing.parent)}><ArrowUp size={16} /></button>
      </div><form className="picker-address" onSubmit={event => { event.preventDefault(); if (address.trim()) go(address.trim()); }}><label className="sr-only" htmlFor="folder-picker-address">文件夹地址</label><Folder size={16} /><input id="folder-picker-address" value={address} onChange={e => { addressEdited.current = true; setAddress(e.target.value); }} placeholder="可粘贴文件夹路径，按 Enter 前往" disabled={busy} /><button type="submit" className="icon-button" aria-label="前往文件夹地址" disabled={!address.trim() || busy}><ArrowRight size={15} /></button></form><button type="button" className="icon-button" aria-label="刷新文件夹列表" disabled={loading || busy} onClick={() => setRefresh(v => v + 1)}><ArrowClockwise size={16} className={loading ? 'spinner' : ''} /></button></div>
      <div className="picker-body"><nav className="picker-locations" aria-label="文件夹快捷位置"><span className="picker-section-label">常用位置</span>{locations?.shortcuts.map(locationButton)}{!locations && <p className="picker-muted">正在读取位置…</p>}<span className="picker-section-label">最近项目</span>{locations?.recents.map(locationButton)}{locations && !locations.recents.length && <p className="picker-muted">打开的项目会显示在这里。</p>}</nav>
        <section className="picker-browser" aria-label="文件夹浏览"><div className="picker-filter"><label><MagnifyingGlass size={15} /><input aria-label="筛选当前文件夹" placeholder="筛选当前目录中的文件夹…" value={query} onChange={e => setQuery(e.target.value)} disabled={busy} /></label><label className="picker-hidden"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} disabled={busy} /><span>显示特殊目录</span></label></div>
          <nav className="picker-breadcrumbs" aria-label="文件夹层级">{listing?.breadcrumbs.map((part, i) => <span key={part.path}>{i > 0 && <CaretRight size={11} />}<button type="button" title={part.path} disabled={busy} onClick={() => go(part.path)}>{part.name}</button></span>)}</nav>
          <div className="picker-folder-list" aria-live="polite" aria-busy={loading}>
            {loading ? <div className="picker-state"><CircleNotch size={25} className="spinner" /><p>正在读取文件夹…</p></div> : browseError ? <div className="picker-state"><WarningCircle size={26} /><p>{browseError}</p><button className="text-button" onClick={() => go(locations?.shortcuts[0]?.path ?? '')}>返回用户目录</button></div> : listing?.folders.length ? listing.folders.map(folder => <div className={`picker-folder-row ${selected === folder.path ? 'selected' : ''}`} key={folder.path}>
              <button type="button" className="picker-folder-choice" title={folder.path} aria-label={`选择文件夹 ${folder.name}`} aria-pressed={selected === folder.path} disabled={busy} onClick={() => setSelected(folder.path)} onDoubleClick={() => go(folder.path)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); go(folder.path); } }}><Folder size={22} weight={selected === folder.path ? 'duotone' : 'regular'} /><span>{folder.name}</span></button><button type="button" className="picker-enter icon-button" aria-label={`进入文件夹 ${folder.name}`} title="进入文件夹" disabled={busy} onClick={() => go(folder.path)}><CaretRight size={16} /></button>
            </div>) : <div className="picker-state"><FolderOpen size={30} /><p>{query ? '没有匹配的子文件夹。' : '当前文件夹没有子文件夹，可直接打开它。'}</p></div>}
          </div><div className="picker-list-note"><span>{listing && !loading && !browseError ? `${listing.total} 个文件夹${listing.truncated ? ' · 仅显示前 400 个，请筛选定位' : ''}` : ''}</span><span>单击选择 · 双击进入</span></div>
        </section></div>
      {error && <p className="picker-error" role="alert"><WarningCircle size={16} />{error}</p>}
      {native && <div className="picker-native-status" role="status"><CircleNotch size={15} className="spinner" /><span>系统选择窗口已打开，请在窗口中选择文件夹。</span><button className="text-button" onClick={() => void cancelNative()}>取消系统选择</button></div>}
      <footer className="picker-footer"><div className="picker-selected"><span>{selected ? '已选择文件夹' : '当前文件夹'}</span><strong title={selected ?? listing?.path}>{selected ?? listing?.path ?? '选择一个位置'}</strong></div><div className="picker-footer-actions">{locations?.nativeAvailable && <button type="button" className="picker-system-button" disabled={busy} onClick={() => void pickNative()}><Monitor size={16} />系统选择…</button>}<button type="button" className="primary-button" disabled={loading || !!browseError || busy || !listing} onClick={() => void open(selected ?? listing!.path)}>{opening ? <CircleNotch size={16} className="spinner" /> : <FolderOpen size={16} />}{opening ? '正在打开…' : '打开此文件夹'}</button></div></footer>
    </div>
  </div>;
}
