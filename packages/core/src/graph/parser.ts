import * as fs from 'fs';
import * as path from 'path';
import { FileNode, FunctionNode, ClassNode } from '../types';
import { GraphCache } from './cache';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TreeSitter = require('tree-sitter');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TypeScript = require('tree-sitter-typescript').typescript;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TSX = require('tree-sitter-typescript').tsx;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JavaScript = require('tree-sitter-javascript');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Python = require('tree-sitter-python');

type SyntaxNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
};

const LANGUAGE_MAP: Record<string, unknown> = {
  '.ts': TypeScript,
  '.tsx': TSX,
  '.js': JavaScript,
  '.jsx': JavaScript,
  '.py': Python,
};

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', 'build'];

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.py') return 'python';
  return 'unknown';
}

function collectNodes(node: SyntaxNode, type: string, results: SyntaxNode[]): void {
  if (node.type === type) results.push(node);
  for (const child of node.children) {
    collectNodes(child, type, results);
  }
}

function collectNodesByTypes(node: SyntaxNode, types: string[], results: SyntaxNode[]): void {
  if (types.includes(node.type)) results.push(node);
  for (const child of node.children) {
    collectNodesByTypes(child, types, results);
  }
}

function extractFunctionName(node: SyntaxNode): string {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;
  // Arrow functions assigned to variables
  if (node.type === 'variable_declarator') {
    const nameField = node.childForFieldName('name');
    return nameField ? nameField.text : '<anonymous>';
  }
  return '<anonymous>';
}

function extractParams(node: SyntaxNode): string[] {
  const paramsNode = node.childForFieldName('parameters');
  if (!paramsNode) return [];
  return paramsNode.namedChildren
    .map((p) => {
      const nameNode = p.childForFieldName('name') ?? p.childForFieldName('pattern');
      return nameNode ? nameNode.text : p.text;
    })
    .filter(Boolean);
}

function extractCallNames(node: SyntaxNode): string[] {
  const calls: string[] = [];
  const callNodes: SyntaxNode[] = [];
  collectNodes(node, 'call_expression', callNodes);
  for (const call of callNodes) {
    const fn = call.childForFieldName('function');
    if (fn) {
      // get the rightmost identifier: foo.bar.baz -> baz, or just foo
      const parts = fn.text.split('.');
      calls.push(parts[parts.length - 1]);
    }
  }
  return [...new Set(calls)];
}

function isExportedNode(node: SyntaxNode): boolean {
  // Walk siblings/parents for 'export' keyword
  if (!node.children) return false;
  return node.children.some((c) => c.type === 'export');
}

function extractFunctions(tree: SyntaxNode, language: string): FunctionNode[] {
  const results: FunctionNode[] = [];
  const fnTypes =
    language === 'python'
      ? ['function_definition']
      : ['function_declaration', 'method_definition', 'arrow_function'];

  const nodes: SyntaxNode[] = [];
  collectNodesByTypes(tree, fnTypes, nodes);

  for (const node of nodes) {
    // For arrow functions, check parent for variable name
    let name = '<anonymous>';
    if (node.type === 'arrow_function') {
      // Parent might be variable_declarator
      name = '<arrow>';
    } else {
      name = extractFunctionName(node);
    }

    const isExported =
      language === 'python'
        ? false
        : isExportedNode(node) ||
          (node.type === 'function_declaration' &&
            node.children.some((c) => c.type === 'export'));

    results.push({
      name,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      calls: extractCallNames(node),
      params: extractParams(node),
      isExported,
    });
  }
  return results;
}

function extractClasses(tree: SyntaxNode, language: string): ClassNode[] {
  const results: ClassNode[] = [];
  const classType = language === 'python' ? 'class_definition' : 'class_declaration';
  const nodes: SyntaxNode[] = [];
  collectNodes(tree, classType, nodes);

  for (const node of nodes) {
    const nameNode = node.childForFieldName('name');
    const name = nameNode ? nameNode.text : '<anonymous>';

    const superclassNode = node.childForFieldName('superclass') ?? node.childForFieldName('bases');
    const extendsName = superclassNode ? superclassNode.text : undefined;

    const methodNodes: SyntaxNode[] = [];
    collectNodes(node, 'method_definition', methodNodes);
    if (language === 'python') collectNodes(node, 'function_definition', methodNodes);
    const methods = methodNodes.map((m) => extractFunctionName(m)).filter((n) => n !== '<anonymous>');

    results.push({
      name,
      methods,
      extends: extendsName,
      isExported: isExportedNode(node),
    });
  }
  return results;
}

function extractImports(tree: SyntaxNode, filePath: string, language: string): string[] {
  const imports: string[] = [];

  if (language === 'python') {
    const importNodes: SyntaxNode[] = [];
    collectNodesByTypes(tree, ['import_statement', 'import_from_statement'], importNodes);
    for (const node of importNodes) {
      const moduleNode = node.childForFieldName('name') ?? node.childForFieldName('module_name');
      if (moduleNode) imports.push(moduleNode.text);
    }
  } else {
    const importNodes: SyntaxNode[] = [];
    collectNodesByTypes(tree, ['import_declaration', 'import_statement'], importNodes);
    for (const node of importNodes) {
      const sourceNode = node.childForFieldName('source');
      if (sourceNode) {
        const raw = sourceNode.text.replace(/['"]/g, '');
        if (raw.startsWith('.')) {
          const dir = path.dirname(filePath);
          const resolved = path.resolve(dir, raw);
          imports.push(resolved);
        } else {
          imports.push(raw);
        }
      }
    }
  }
  return imports;
}

function extractExports(tree: SyntaxNode): string[] {
  const exports: string[] = [];
  const exportNodes: SyntaxNode[] = [];
  collectNodesByTypes(tree, ['export_statement', 'export_declaration'], exportNodes);
  for (const node of exportNodes) {
    const nameNode = node.childForFieldName('name') ?? node.childForFieldName('declaration');
    if (nameNode) exports.push(nameNode.text);
    // export { a, b, c }
    const clauseNodes: SyntaxNode[] = [];
    collectNodes(node, 'export_specifier', clauseNodes);
    for (const spec of clauseNodes) {
      const n = spec.childForFieldName('name');
      if (n) exports.push(n.text);
    }
  }
  return [...new Set(exports)];
}

export class Parser {
  private tsParser: typeof TreeSitter;
  private cache: GraphCache | null;

  constructor(cache?: GraphCache) {
    this.tsParser = new TreeSitter();
    this.cache = cache ?? null;
  }

  async parseFile(filePath: string): Promise<FileNode> {
    const ext = path.extname(filePath).toLowerCase();
    const lang = LANGUAGE_MAP[ext];
    const language = detectLanguage(filePath);
    const stat = await fs.promises.stat(filePath);

    // Check incremental cache first — skip re-parsing if mtime unchanged
    if (this.cache) {
      const cached = this.cache.get(filePath, stat.mtimeMs);
      if (cached) return cached;
    }

    if (!lang) {
      const node: FileNode = {
        path: filePath,
        language: 'unknown',
        functions: [],
        classes: [],
        imports: [],
        exports: [],
        lastModified: stat.mtimeMs,
        size: stat.size,
      };
      this.cache?.set(filePath, stat.mtimeMs, node);
      return node;
    }

    this.tsParser.setLanguage(lang);
    const source = await fs.promises.readFile(filePath, 'utf8');
    const tree = this.tsParser.parse(source);
    const root = tree.rootNode as SyntaxNode;

    const node: FileNode = {
      path: filePath,
      language,
      functions: extractFunctions(root, language),
      classes: extractClasses(root, language),
      imports: extractImports(root, filePath, language),
      exports: extractExports(root),
      lastModified: stat.mtimeMs,
      size: stat.size,
    };

    this.cache?.set(filePath, stat.mtimeMs, node);
    return node;
  }

  async parseRepo(
    repoPath: string,
    options?: { exclude?: string[] }
  ): Promise<FileNode[]> {
    const excludes = [...DEFAULT_EXCLUDES, ...(options?.exclude ?? [])];
    const files: FileNode[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (excludes.some((ex) => entry.name === ex || entry.name.startsWith(ex))) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (LANGUAGE_MAP[ext]) {
            try {
              const node = await this.parseFile(fullPath);
              files.push(node);
            } catch {
              // Skip unparseable files
            }
          }
        }
      }
    };

    await walk(repoPath);
    return files;
  }
}
