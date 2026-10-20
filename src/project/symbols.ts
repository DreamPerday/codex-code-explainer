import ts from 'typescript-parser';
import { parser as python } from '@lezer/python';
import type { SyntaxNode } from '@lezer/common';
import { createHash } from 'node:crypto';
import type { FileSnapshot } from '../shared/contracts.js';
import type { MindNode, MindKind } from '../shared/mind-map.js';

export type SourceImport = { module: string; names: { local: string; imported: string }[] };
export type ParsedFile = { nodes: MindNode[]; imports: SourceImport[]; supported: boolean; hasErrors: boolean };
export const nodeId = (path: string, kind: string, name = '', offset = 0) => createHash('sha256').update(`${path}\0${kind}\0${name}\0${offset}`).digest('hex').slice(0, 24);
const compact = (s: string, max = 340) => s.replace(/\s+/g, ' ').trim().slice(0, max);
const cleanDoc = (s: string) => s.replace(/^\s*\/\*+\s?/, '').replace(/\s*\*\/\s*$/, '').replace(/^\s*\*\s?/gm, '').replace(/^\s*\/\/\s?/gm, '').trim();

export function parseSymbols(file: FileSnapshot): ParsedFile {
  const lineOffsets = [0];
  for (let n = 0; n < file.text.length; n++) if (file.text[n] === '\n') lineOffsets.push(n + 1);
  const lineAt = (offset: number) => {
    let low = 0, high = lineOffsets.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (lineOffsets[mid] <= offset) low = mid; else high = mid; }
    return low + 1;
  };
  const nodes: MindNode[] = [];
  const imports: SourceImport[] = [];
  const fileId = nodeId(file.path, 'file');
  const make = (kind: MindKind, name: string, from: number, to: number, owner: MindNode | undefined, signature: string, doc = '') => {
    const qualifiedName = owner ? `${owner.qualifiedName}.${name}` : name;
    const node: MindNode = { id: nodeId(file.path, kind, qualifiedName, from), parentId: owner?.id ?? fileId, kind, name, qualifiedName,
      path: file.path, line: lineAt(from), endLine: lineAt(Math.max(from, to - 1)), sourceVersion: file.version,
      signature: compact(signature), summary: doc ? compact(doc, 180) : kind === 'class' ? '类定义；展开查看方法与成员。' : kind === 'interface' || kind === 'type' ? '类型与数据结构约定。' : '查看签名、返回表达式及调用；可使用 AI 详细总结。', basis: doc ? 'comment' : 'syntax' };
    nodes.push(node); return node;
  };

  if (/\.pyi?$/.test(file.path)) {
    const tree = python.parse(file.text);
    let hasErrors = false;
    const text = (n: SyntaxNode | null) => n ? file.text.slice(n.from, n.to) : '';
    const walk = (syntax: SyntaxNode, owner?: MindNode) => {
      if (syntax.type.isError) hasErrors = true;
      let nextOwner = owner;
      if (['ClassDefinition', 'FunctionDefinition'].includes(syntax.name)) {
        const body = syntax.getChild('Body'); const name = text(syntax.getChild('VariableName'));
        const first = body?.firstChild?.nextSibling;
        const docNode = first?.name === 'ExpressionStatement' ? first.getChild('String') : null;
        const doc = text(docNode).replace(/^[rRuUbBfF]*(?:"""|'''|"|')/, '').replace(/(?:"""|'''|"|')$/, '');
        const from = syntax.parent?.name === 'DecoratedStatement' ? syntax.parent.from : syntax.from;
        if (name) {
          const kind = syntax.name === 'ClassDefinition' ? 'class' : owner?.kind === 'class' ? 'method' : 'function';
          nextOwner = make(kind, name, from, syntax.to, owner, file.text.slice(syntax.from, body?.from ?? syntax.to), doc);
          if (kind === 'class') nextOwner.bases = text(syntax.getChild('ArgList')).replace(/^\(|\)$/g, '').split(',').map(s => s.trim()).filter(Boolean);
          else {
            const params = syntax.getChild('ParamList');
            const parameters: string[] = []; let start = (params?.from ?? 0) + 1;
            for (let child = params?.firstChild; child; child = child.nextSibling) if (child.name === ',') { parameters.push(file.text.slice(start, child.from).trim()); start = child.to; }
            if (params) parameters.push(file.text.slice(start, params.to - 1).trim());
            nextOwner.parameters = parameters.filter(Boolean);
            const result = syntax.getChild('TypeDef');
            nextOwner.returns = result ? [`类型：${text(result)}`] : [];
            nextOwner.calls = [];
          }
        }
      }
      if (syntax.name === 'ImportStatement') {
        const statement = text(syntax).replace(/\n\s*/g, ' ').replace(/[()]/g, '');
        const from = statement.match(/^from\s+([.\w]+)\s+import\s+(.+)/);
        if (from) imports.push({ module: from[1], names: from[2].split(',').map(s => { const [imported, local] = s.trim().split(/\s+as\s+/); return { imported, local: local ?? imported }; }) });
        else for (const m of statement.replace(/^import\s+/, '').split(',')) {
          const [module, alias] = m.trim().split(/\s+as\s+/); if (module) imports.push({ module, names: [{ local: alias ?? module.split('.')[0], imported: '*' }] });
        }
      }
      if (owner && ['function', 'method'].includes(owner.kind)) {
        if (syntax.name === 'CallExpression') {
          const callee = compact(text(syntax.firstChild), 100);
          if (callee && !owner.calls!.includes(callee) && owner.calls!.length < 35) owner.calls!.push(callee);
        }
        if (syntax.name === 'ReturnStatement') {
          const value = compact(text(syntax).replace(/^return\s*/, ''), 200) || 'None';
          if (!owner.returns!.includes(value) && owner.returns!.length < 8) owner.returns!.push(value);
        }
      }
      for (let child = syntax.firstChild; child; child = child.nextSibling) walk(child, nextOwner);
    };
    walk(tree.topNode);
    return { nodes, imports, supported: true, hasErrors };
  }

  if (/\.[cm]?[jt]sx?$/.test(file.path)) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, /x$/.test(file.path) ? (/tsx$/.test(file.path) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX) : /\.[cm]?js$/.test(file.path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const doc = (node: ts.Node) => {
      const comments = ts.getLeadingCommentRanges(file.text, node.getFullStart()) ?? [];
      const last = comments.at(-1);
      return last ? cleanDoc(file.text.slice(last.pos, last.end)) : '';
    };
    const nameOf = (node: ts.Node) => 'name' in node && node.name && typeof node.name === 'object' && 'getText' in node.name ? (node.name as ts.Node).getText(source) : '';
    const functionDefinitions = new Map<ts.Node, MindNode>();
    const walk = (syntax: ts.Node, owner?: MindNode, executionOwner?: MindNode) => {
      let nextOwner = owner;
      let nextExecutionOwner = executionOwner;
      let kind: MindKind | undefined;
      let definition: ts.Node = syntax;
      let name = nameOf(syntax);
      if (ts.isClassDeclaration(syntax) || ts.isClassExpression(syntax)) { kind = 'class'; name ||= 'default'; }
      else if (ts.isFunctionDeclaration(syntax)) { kind = 'function'; name ||= 'default'; }
      else if (ts.isMethodDeclaration(syntax) || ts.isMethodSignature(syntax) || ts.isGetAccessor(syntax) || ts.isSetAccessor(syntax)) kind = 'method';
      else if (ts.isConstructorDeclaration(syntax)) { kind = 'method'; name = 'constructor'; }
      else if (ts.isInterfaceDeclaration(syntax)) kind = 'interface';
      else if (ts.isTypeAliasDeclaration(syntax)) kind = 'type';
      else if (ts.isEnumDeclaration(syntax)) kind = 'enum';
      else if ((ts.isVariableDeclaration(syntax) || ts.isPropertyDeclaration(syntax) || ts.isPropertyAssignment(syntax)) && syntax.initializer && (ts.isArrowFunction(syntax.initializer) || ts.isFunctionExpression(syntax.initializer))) { kind = owner?.kind === 'class' ? 'method' : 'function'; definition = syntax.initializer; }
      else if ((ts.isPropertyDeclaration(syntax) || ts.isPropertySignature(syntax)) && owner && ['class', 'interface'].includes(owner.kind)) kind = 'property';
      if (kind && name) {
        const body = 'body' in definition ? definition.body as ts.Node | undefined : undefined;
        const start = syntax.getStart(source);
        const endSignature = ts.isClassDeclaration(syntax) || ts.isClassExpression(syntax) || ts.isInterfaceDeclaration(syntax) || ts.isEnumDeclaration(syntax)
          ? syntax.members.pos : body?.getStart(source) ?? syntax.end;
        const commentOwner = ts.isVariableDeclaration(syntax) && ts.isVariableDeclarationList(syntax.parent) ? syntax.parent.parent : syntax;
        nextOwner = make(kind, name, start, syntax.end, owner, file.text.slice(start, endSignature), doc(commentOwner));
        if ('parameters' in definition) nextOwner.parameters = (definition.parameters as ts.NodeArray<ts.ParameterDeclaration>).map(p => p.getText(source));
        nextOwner.returns = 'type' in definition && definition.type ? [`类型：${(definition.type as ts.Node).getText(source)}`] : [];
        nextOwner.calls = [];
        nextExecutionOwner = ['function', 'method'].includes(kind) ? nextOwner : undefined;
        if (nextExecutionOwner) {
          functionDefinitions.set(definition, nextExecutionOwner);
          if (ts.isArrowFunction(definition) && !ts.isBlock(definition.body)) nextExecutionOwner.returns!.push(compact(definition.body.getText(source), 200));
        }
        if (ts.isClassDeclaration(syntax) || ts.isClassExpression(syntax) || ts.isInterfaceDeclaration(syntax)) nextOwner.bases = syntax.heritageClauses?.flatMap(h => h.types.map(t => t.getText(source))) ?? [];
      }
      if (ts.isImportDeclaration(syntax) && ts.isStringLiteral(syntax.moduleSpecifier)) {
        const names: SourceImport['names'] = []; const clause = syntax.importClause;
        if (clause?.name) names.push({ local: clause.name.text, imported: 'default' });
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.push({ local: bindings.name.text, imported: '*' });
        else if (bindings) for (const element of bindings.elements) names.push({ local: element.name.text, imported: element.propertyName?.text ?? element.name.text });
        imports.push({ module: syntax.moduleSpecifier.text, names });
      }
      // Anonymous callbacks have their own execution scope; their returns must
      // never be presented as return values of the containing function.
      if (ts.isArrowFunction(syntax) || ts.isFunctionExpression(syntax)) nextExecutionOwner = functionDefinitions.get(syntax);
      if (nextExecutionOwner) {
        if (ts.isCallExpression(syntax) || ts.isNewExpression(syntax)) {
          const callee = compact(syntax.expression.getText(source), 100);
          if (!nextExecutionOwner.calls!.includes(callee) && nextExecutionOwner.calls!.length < 35) nextExecutionOwner.calls!.push(callee);
        }
        if (ts.isReturnStatement(syntax)) {
          const value = compact(syntax.expression?.getText(source) ?? 'undefined', 200);
          if (!nextExecutionOwner.returns!.includes(value) && nextExecutionOwner.returns!.length < 8) nextExecutionOwner.returns!.push(value);
        }
      }
      ts.forEachChild(syntax, child => walk(child, nextOwner, nextExecutionOwner));
    };
    walk(source);
    return { nodes, imports, supported: true, hasErrors: !!(source as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics?.length };
  }
  return { nodes: [], imports: [], supported: false, hasErrors: false };
}
