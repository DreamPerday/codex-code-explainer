import type { MindNode } from '../shared/mind-map.js';

export type PlacedNode = { node: MindNode; x: number; y: number; childCount: number };
export function mindLayout(nodes: MindNode[], rootId: string, expanded: Set<string>, query = '', limit = 350, size = 1) {
  const nodeWidth = 280 * size, nodeHeight = 92 * size, column = 324 * size, row = 120 * size;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const children = new Map<string, MindNode[]>();
  for (const node of nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const match = new Set<string>(); const allowed = new Set<string>();
  const term = query.trim().toLowerCase();
  if (term) for (const node of nodes) if (`${node.name} ${node.qualifiedName} ${node.summary} ${node.analysis?.summary ?? ''}`.toLowerCase().includes(term)) {
    match.add(node.id); let current: MindNode | undefined = node;
    while (current && !allowed.has(current.id)) { allowed.add(current.id); current = byId.get(current.parentId ?? ''); }
  }
  let leaf = 0, truncated = false;
  const positions: PlacedNode[] = [];
  const links: { from: PlacedNode; to: PlacedNode }[] = [];
  const place = (id: string, depth: number): PlacedNode | null => {
    const node = byId.get(id);
    if (!node || term && !allowed.has(id)) return null;
    if (positions.length >= limit) { truncated = true; return null; }
    const all = children.get(id) ?? [];
    const item: PlacedNode = { node, x: 24 + depth * column, y: 0, childCount: all.length };
    positions.push(item);
    const visible = (expanded.has(id) || term) ? all.map(child => place(child.id, depth + 1)).filter((n): n is PlacedNode => n !== null) : [];
    if (visible.length) {
      item.y = (visible[0].y + visible.at(-1)!.y) / 2;
      for (const child of visible) links.push({ from: item, to: child });
    } else item.y = 24 + leaf++ * row;
    return item;
  };
  place(rootId, 0);
  return { positions, links, matches: match, truncated, nodeWidth, nodeHeight, width: Math.max(400, ...positions.map(n => n.x + nodeWidth + 24)), height: Math.max(160, leaf * row + 48) };
}

export function expandAncestors(nodes: MindNode[], id: string, current = new Set<string>()) {
  const result = new Set(current); const byId = new Map(nodes.map(n => [n.id, n])); let node = byId.get(id);
  while (node) { result.add(node.id); node = byId.get(node.parentId ?? ''); }
  return result;
}
