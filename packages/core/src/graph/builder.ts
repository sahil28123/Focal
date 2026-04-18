import * as path from 'path';
import { FileNode, CodeGraph } from '../types';

export class GraphBuilder {
  build(files: FileNode[]): CodeGraph {
    const fileMap = new Map<string, FileNode>();
    for (const f of files) {
      fileMap.set(f.path, f);
    }

    // Build import graph: resolve imports to known file paths
    const importGraph = new Map<string, string[]>();
    for (const file of files) {
      const resolved: string[] = [];
      for (const imp of file.imports) {
        // Try adding known extensions if not already present
        const candidate = this.resolveImport(imp, fileMap);
        if (candidate) resolved.push(candidate);
        else resolved.push(imp); // keep unresolved (e.g. npm packages)
      }
      importGraph.set(file.path, resolved);
    }

    // Build call graph: functionId -> [called functionIds]
    // functionId format: "filePath::functionName"
    const callGraph = new Map<string, string[]>();

    // Build a lookup: functionName -> [functionId] across all files
    const fnLookup = new Map<string, string[]>();
    for (const file of files) {
      for (const fn of file.functions) {
        const id = `${file.path}::${fn.name}`;
        if (!fnLookup.has(fn.name)) fnLookup.set(fn.name, []);
        fnLookup.get(fn.name)!.push(id);
      }
    }

    for (const file of files) {
      for (const fn of file.functions) {
        const id = `${file.path}::${fn.name}`;
        const calledIds: string[] = [];
        for (const callee of fn.calls) {
          const candidates = fnLookup.get(callee);
          if (candidates) calledIds.push(...candidates);
        }
        callGraph.set(id, [...new Set(calledIds)]);
      }
    }

    return {
      files: fileMap,
      callGraph,
      importGraph,
      builtAt: Date.now(),
    };
  }

  private resolveImport(
    importPath: string,
    fileMap: Map<string, FileNode>
  ): string | null {
    // Already absolute and known
    if (fileMap.has(importPath)) return importPath;

    // Try with extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py'];
    for (const ext of extensions) {
      const candidate = importPath + ext;
      if (fileMap.has(candidate)) return candidate;
    }

    // Try index files
    for (const ext of extensions) {
      const candidate = path.join(importPath, `index${ext}`);
      if (fileMap.has(candidate)) return candidate;
    }

    return null;
  }
}
