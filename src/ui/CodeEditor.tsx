import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLineGutter, drawSelection, keymap, highlightActiveLine } from '@codemirror/view';
import { syntaxHighlighting, HighlightStyle, foldGutter, bracketMatching } from '@codemirror/language';
import { defaultKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { tags } from '@lezer/highlight';
import type { FileSnapshot, Selection } from '../shared/contracts.js';

export type CodeSelection = Selection & { anchor: { x: number; y: number }; user: boolean };
const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--syntax-function)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: tags.comment, color: '#8e9693', fontStyle: 'italic' },
]);
function language(file: string): Extension {
  if (/\.pyi?$/.test(file)) return python();
  if (/\.[cm]?[jt]sx?$/.test(file)) return javascript({ typescript: /\.[cm]?tsx?$/.test(file), jsx: /x$/.test(file) });
  if (/\.json$/.test(file)) return json();
  if (/\.mdx?$/.test(file)) return markdown();
  if (/\.(html?|vue|svelte)$/.test(file)) return html();
  if (/\.(css|scss|less)$/.test(file)) return css();
  return [];
}
export function CodeEditor({ file, onSelection, onExplain, jump }: {
  file: FileSnapshot; onSelection: (selection: CodeSelection | null) => void; onExplain: () => void;
  jump: { line: number; lastLine?: number; serial: number } | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onSelection, onExplain });
  callbacks.current = { onSelection, onExplain };
  useEffect(() => {
    if (!container.current) return;
    const state = EditorState.create({ doc: file.text, extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-label': '源码阅读区域', tabindex: '0' }),
      lineNumbers(), highlightActiveLineGutter(), foldGutter(), drawSelection(), highlightActiveLine(), bracketMatching(), highlightSelectionMatches(),
      language(file.path), syntaxHighlighting(highlighting),
      keymap.of([{ key: 'Mod-Enter', run: () => { callbacks.current.onExplain(); return true; } }, ...defaultKeymap, ...searchKeymap]),
      EditorView.updateListener.of(update => {
        if (!update.selectionSet) return;
        const range = update.state.selection.main;
        if (range.empty) { callbacks.current.onSelection(null); return; }
        const pos = update.view.coordsAtPos(range.to);
        callbacks.current.onSelection({ from: range.from, to: range.to,
          startLine: update.state.doc.lineAt(range.from).number,
          endLine: update.state.doc.lineAt(Math.max(range.from, range.to - 1)).number,
          anchor: { x: pos?.right ?? 480, y: pos?.bottom ?? 160 },
          user: update.transactions.some(t => t.isUserEvent('select')),
        });
      }),
      EditorView.theme({
        '&': { height: '100%', background: 'var(--code)', color: 'var(--text)', fontSize: '13px' },
        '.cm-scroller': { fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace', lineHeight: '1.8', overflow: 'auto' },
        '.cm-content': { padding: '24px 0 120px' }, '.cm-line': { padding: '0 24px 0 16px' },
        '.cm-gutters': { backgroundColor: 'var(--code)', color: 'var(--muted)', border: 'none', minWidth: '60px', paddingLeft: '10px' },
        '.cm-activeLineGutter,.cm-activeLine': { backgroundColor: 'var(--hover)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
        '&.cm-focused': { outline: 'none' }, '.cm-cursor': { borderLeftColor: 'var(--accent)' },
        '.cm-panels': { background: 'var(--surface)', color: 'var(--text)' },
      }),
    ] });
    const editor = new EditorView({ state, parent: container.current });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [file.path, file.version]);
  useEffect(() => {
    if (!view.current || !jump) return;
    const line = view.current.state.doc.line(Math.min(jump.line, view.current.state.doc.lines));
    const last = view.current.state.doc.line(Math.min(Math.max(jump.lastLine ?? jump.line, jump.line), view.current.state.doc.lines));
    view.current.dispatch({ selection: { anchor: line.from, head: jump.lastLine ? last.to : line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.current.focus();
  }, [jump, file.path, file.version]);
  return <div className="editor-host" ref={container} />;
}
