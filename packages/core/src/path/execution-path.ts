import { CodeGraph, ExecutionPath, PathNode, PinnedNode } from '../types';

/**
 * Reconstructs the execution path from a stack trace + call graph.
 *
 * Problem it solves: a raw stack trace gives you a list of frames but no
 * structural understanding of HOW control flowed between them. This builder
 * cross-references the stack frames against the call graph to verify each hop,
 * fill gaps, and produce a single ordered chain the agent can reason about.
 *
 * Result:  entryPoint → middleware → auth → tokenValidator (error site)
 * Instead: three isolated files with no relationship shown
 */
export class ExecutionPathBuilder {
  build(pinnedNodes: PinnedNode[], graph: CodeGraph): ExecutionPath | null {
    // Only operate on stack_trace nodes — other signal types don't have ordering
    const stackFrames = pinnedNodes
      .filter((p) => p.source === 'stack_trace')
      .sort((a, b) => (a.errorSignalBoost > b.errorSignalBoost ? -1 : 1));
      // Stack traces are stored closest-to-error first (highest boost), so this
      // ordering is already correct for entry→error reconstruction when reversed

    if (stackFrames.length < 2) return null;

    // Reverse so we go from entry point → error site
    const ordered = [...stackFrames].reverse();

    const pathNodes: PathNode[] = [];
    let verifiedHops = 0;
    let totalHops = 0;

    for (let i = 0; i < ordered.length; i++) {
      const frame = ordered[i];
      const fileNode = graph.files.get(frame.filePath);

      let verified = false;

      if (i > 0) {
        totalHops++;
        const prevFrame = ordered[i - 1];
        // Verify: does prev frame's symbol call into current frame's symbol?
        verified = this.verifyCallHop(prevFrame, frame, graph);
        if (verified) verifiedHops++;
      }

      pathNodes.push({
        filePath: frame.filePath,
        functionName: frame.symbol ?? this.inferFunction(frame.filePath, frame.line, graph),
        line: frame.line,
        verified: i === 0 ? true : verified, // entry point is trivially "verified"
        isErrorSite: i === ordered.length - 1,
        isEntryPoint: i === 0,
      });

      // If a hop can't be verified, try to fill the gap via call graph
      if (i > 0 && !verified && fileNode) {
        const gap = this.findGapNodes(ordered[i - 1], frame, graph);
        // Insert gap nodes before the current node (already added above)
        // Splice them in — we'll rebuild from the array after the loop
        for (const gapNode of gap) {
          pathNodes.splice(pathNodes.length - 1, 0, gapNode);
        }
      }
    }

    const errorSite = pathNodes[pathNodes.length - 1];
    const entryPoint = pathNodes[0];
    const confidence = totalHops > 0 ? verifiedHops / totalHops : 0.5;

    return { nodes: pathNodes, errorSite, entryPoint, confidence };
  }

  /**
   * Verify that `from` calls into `to` via the call graph.
   * Returns true if we find a direct or 1-hop chain.
   */
  private verifyCallHop(from: PinnedNode, to: PinnedNode, graph: CodeGraph): boolean {
    const fromFile = graph.files.get(from.filePath);
    if (!fromFile) return false;

    // Find matching function in from-file
    const fromFn = from.symbol
      ? fromFile.functions.find((f) => f.name === from.symbol)
      : this.functionAtLine(fromFile, from.line);

    if (!fromFn) return false;
    const fromId = `${from.filePath}::${fromFn.name}`;

    // Check if fromId calls any function in to-file
    const callees = graph.callGraph.get(fromId) ?? [];
    for (const callee of callees) {
      if (callee.startsWith(to.filePath + '::')) return true;
      // 1-hop via import: calleeFile imports toFile
      const calleeFile = callee.split('::')[0];
      const calleeImports = graph.importGraph.get(calleeFile) ?? [];
      if (calleeImports.includes(to.filePath)) return true;
    }

    // Also check: does from-file import to-file?
    const fromImports = graph.importGraph.get(from.filePath) ?? [];
    return fromImports.includes(to.filePath);
  }

  /**
   * When a hop can't be directly verified, try to find intermediate nodes
   * via the call graph that connect `from` to `to`.
   */
  private findGapNodes(from: PinnedNode, to: PinnedNode, graph: CodeGraph): PathNode[] {
    // BFS up to 2 hops
    const fromImports = graph.importGraph.get(from.filePath) ?? [];
    const toImports = graph.importGraph.get(to.filePath) ?? [];

    // Simple case: find a file imported by `from` that also imports `to`
    for (const mid of fromImports) {
      if (mid === to.filePath) continue;
      const midImports = graph.importGraph.get(mid) ?? [];
      if (midImports.includes(to.filePath)) {
        return [{
          filePath: mid,
          verified: false,
          isErrorSite: false,
          isEntryPoint: false,
        }];
      }
    }

    return [];
  }

  private functionAtLine(fileNode: { functions: Array<{ name: string; startLine: number; endLine: number }> }, line?: number): { name: string } | undefined {
    if (!line) return fileNode.functions[0];
    return fileNode.functions.find((f) => f.startLine <= line && line <= f.endLine);
  }

  private inferFunction(filePath: string, line?: number, graph?: CodeGraph): string | undefined {
    if (!graph || !line) return undefined;
    const fileNode = graph.files.get(filePath);
    if (!fileNode) return undefined;
    const fn = this.functionAtLine(fileNode, line);
    return fn?.name;
  }
}
