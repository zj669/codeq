import {
  DEFINITION_KINDS,
  inPathScope,
  isGiantSpan,
  kindRank,
  queryIdentifiers,
} from "./graph-map.js";

const CALL_KINDS = new Set(["calls", "instantiates"]);
const MEMBER_KINDS = new Set(["function", "method"]);

const BLAST_LINE = /^- `([^`]+)`\s+\(([^()]+?):(\d+)\)\s+—\s+/;

export function queryWithoutScope(query) {
  return String(query || "").replace(/\s+path:\S+\s*$/, "");
}

export function pathConstraint(query) {
  const match = String(query || "").match(/\s+path:(\S+)\s*$/);
  return match ? match[1] : null;
}

export function definitionHints(text) {
  const hints = new Map();
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("**Source Code**") || line.startsWith("**`")) break;
    const blast = line.match(BLAST_LINE);
    if (!blast) continue;
    const key = blast[1].toLowerCase();
    if (hints.has(key)) continue;
    hints.set(key, { name: blast[1], path: blast[2], line: Number(blast[3]) });
  }
  return hints;
}

export function pickDefinition(nodes, hint) {
  const defs = (nodes || []).filter(
    (node) => node && DEFINITION_KINDS.has(node.kind) && node.startLine > 0 && node.filePath,
  );
  if (defs.length === 0) return null;
  if (hint) {
    const exact = defs.find(
      (node) => node.filePath === hint.path && node.startLine === hint.line,
    );
    if (exact) return exact;
    const containing = defs
      .filter(
        (node) =>
          node.filePath === hint.path &&
          node.startLine <= hint.line &&
          (node.endLine || node.startLine) >= hint.line,
      )
      .sort(
        (a, b) =>
          (a.endLine || a.startLine) -
          a.startLine -
          ((b.endLine || b.startLine) - b.startLine),
      );
    if (containing.length > 0) return containing[0];
  }
  return [...defs].sort((a, b) => {
    const byKind = kindRank(a.kind) - kindRank(b.kind);
    if (byKind) return byKind;
    const span =
      (a.endLine || a.startLine) -
      a.startLine -
      ((b.endLine || b.startLine) - b.startLine);
    if (span) return span;
    return a.startLine - b.startLine;
  })[0];
}

function relatedNodes(node, edges, getNode, endpoint) {
  const seen = new Set();
  const related = [];
  for (const edge of edges || []) {
    if (!edge || !CALL_KINDS.has(edge.kind)) continue;
    const other = getNode(edge[endpoint]);
    if (!other || other.id === node.id || !other.startLine || !other.filePath) continue;
    const key = `${other.name}\0${other.filePath}\0${other.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    related.push(other);
  }
  return related;
}

export function directCalleeNodes(node, edges, getNode) {
  return relatedNodes(node, edges, getNode, "target");
}

export function directCallerNodes(node, edges, getNode) {
  return relatedNodes(node, edges, getNode, "source");
}

function locator(node) {
  return {
    name: node.name,
    path: node.filePath,
    line: node.startLine,
    endLine: node.endLine || node.startLine,
  };
}

function callerCount(graph, nodeId) {
  if (typeof graph.getIncomingEdges !== "function") return 0;
  try {
    return (graph.getIncomingEdges(nodeId) || []).filter(
      (edge) => edge && CALL_KINDS.has(edge.kind),
    ).length;
  } catch {
    return 0;
  }
}

// Callable definitions nested inside a giant definition's span. These are what
// the reply offers instead of the whole span, so each one carries its own
// caller count: the most-called method is the most useful way in.
export function memberNodes(graph, node) {
  const end = node.endLine || node.startLine;
  if (!isGiantSpan(node.startLine, end)) return [];
  if (typeof graph.getNodesInFile !== "function") return [];
  let inFile = [];
  try {
    inFile = graph.getNodesInFile(node.filePath) || [];
  } catch {
    return [];
  }
  return inFile
    .filter(
      (other) =>
        other &&
        other.id !== node.id &&
        MEMBER_KINDS.has(other.kind) &&
        other.startLine > node.startLine &&
        (other.endLine || other.startLine) <= end,
    )
    .map((other) => ({
      name: other.name,
      path: other.filePath,
      line: other.startLine,
      endLine: other.endLine || other.startLine,
      callerCount: callerCount(graph, other.id),
    }));
}

function exactNameDefsFromNodes(nodes, name, constraint) {
  const wanted = name.toLowerCase();
  return (nodes || []).filter((node) => {
    if (!node || !DEFINITION_KINDS.has(node.kind)) return false;
    if (!node.startLine || !node.filePath) return false;
    if (String(node.name).toLowerCase() !== wanted) return false;
    return inPathScope(node.filePath, constraint);
  });
}

function exactNameDefs(graph, name, constraint) {
  return exactNameDefsFromNodes(graph.getNodesByName(name) || [], name, constraint);
}

function locatorsFrom(node, edges, getNode, endpoint) {
  return relatedNodes(node, edges, getNode, endpoint).map(locator);
}

function collectExactNameDefs(graph, names, constraint) {
  const defsByName = new Map();
  for (const name of names) {
    defsByName.set(name, exactNameDefs(graph, name, constraint));
  }
  return defsByName;
}

function symbolsFromExactDefs(graph, defsByName) {
  const symbols = [];
  const seen = new Set();
  const getNode = (id) => graph.getNode(id);
  for (const nodes of defsByName.values()) {
    for (const node of nodes) {
      const key = `${node.name}\0${node.filePath}\0${node.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        name: node.name,
        kind: node.kind,
        path: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine || node.startLine,
        callees: locatorsFrom(node, graph.getOutgoingEdges(node.id), getNode, "target"),
        callers: locatorsFrom(
          node,
          typeof graph.getIncomingEdges === "function"
            ? graph.getIncomingEdges(node.id)
            : [],
          getNode,
          "source",
        ),
        members: memberNodes(graph, node),
      });
    }
  }
  return symbols;
}

export function identifiersHaveExactDefs(graph, query) {
  const names = queryIdentifiers(queryWithoutScope(query));
  if (names.length === 0) return false;
  if (typeof graph?.getNodesByName !== "function") return false;
  try {
    const defsByName = collectExactNameDefs(graph, names, pathConstraint(query));
    return names.every((name) => defsByName.get(name).length > 0);
  } catch {
    return false;
  }
}

export function symbolIndex(graph, query) {
  const names = queryIdentifiers(queryWithoutScope(query));
  const constraint = pathConstraint(query);
  return symbolsFromExactDefs(graph, collectExactNameDefs(graph, names, constraint));
}

export async function graphSearch(graph, query, explore) {
  const names = queryIdentifiers(queryWithoutScope(query));
  const canResolve =
    names.length > 0 && typeof graph?.getNodesByName === "function";
  let defsByName = null;
  if (canResolve) {
    try {
      defsByName = collectExactNameDefs(graph, names, pathConstraint(query));
    } catch {
      defsByName = null;
    }
  }

  const allExact =
    defsByName &&
    names.every((name) => (defsByName.get(name) || []).length > 0);

  if (allExact) {
    try {
      return { result: "", symbols: symbolsFromExactDefs(graph, defsByName) };
    } catch {
      // Fall through to the 0.3.2 explore + pin path.
    }
  }

  const text = await explore(query);
  let symbols = [];
  try {
    symbols = defsByName
      ? symbolsFromExactDefs(graph, defsByName)
      : symbolIndex(graph, query);
  } catch {
    symbols = [];
  }
  return { result: text, symbols };
}

export { DEFINITION_KINDS };
