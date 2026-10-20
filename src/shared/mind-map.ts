export type MindKind = 'project' | 'directory' | 'file' | 'class' | 'function' | 'method' | 'interface' | 'type' | 'enum' | 'property';
export type SymbolAnalysis = { id: string; summary: string; inputs: string[]; outputs: string[]; steps: string[]; cautions: string[] };
export type Architecture = { summary: string; layers: { name: string; responsibility: string; nodeIds: string[] }[]; flow: string[]; coverage: string };
export type MindNode = {
  id: string; parentId: string | null; kind: MindKind; name: string; qualifiedName: string; summary: string;
  path?: string; line?: number; endLine?: number; sourceVersion?: string;
  signature?: string; parameters?: string[]; returns?: string[]; bases?: string[]; calls?: string[];
  basis: 'syntax' | 'comment'; analysis?: SymbolAnalysis;
};
export type MindEdge = { from: string; to: string; kind: 'imports' | 'calls' | 'inherits' };
export type MindMap = {
  version: string; name: string; rootId: string; nodes: MindNode[]; edges: MindEdge[]; architecture?: Architecture;
  coverage: { totalFiles: number; indexedFiles: number; parsedFiles: number; symbols: number; skipped: string[]; truncated: boolean; notes: string[] };
};
export type MindJob = {
  id: string; status: 'pending' | 'complete' | 'cancelled' | 'failed' | 'stale';
  completed: number; total: number; analyses: SymbolAnalysis[]; architecture?: Architecture; error?: string;
};
