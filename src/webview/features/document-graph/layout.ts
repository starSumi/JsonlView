import type { GraphEdgeV2, GraphNodeV2, GraphSnapshotV2 } from '@shared/contracts/graph';

export interface PositionedGraphNode { node: GraphNodeV2; x: number; y: number; depth: number; childCount: number }
export interface GraphHierarchyLayout { nodes: PositionedGraphNode[]; edges: GraphEdgeV2[]; width: number; height: number }

/** Synchronous, at most 100 nodes / 200 edges. No worker or late layout publication. */
export function layoutDocumentGraph(snapshot: GraphSnapshotV2, collapsed: ReadonlySet<string>): GraphHierarchyLayout {
  const nodes = snapshot.nodes.slice(0, 100);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const children = new Map<string, string[]>(); const parents = new Map<string, string>();
  const edges = snapshot.edges.slice(0, 200).filter((edge) => byId.has(edge.fromNodeId) && byId.has(edge.toNodeId));
  for (const edge of edges) {
    if (edge.kind !== 'parent' || parents.has(edge.toNodeId) || edge.fromNodeId === edge.toNodeId) continue;
    parents.set(edge.toNodeId, edge.fromNodeId);
    const list = children.get(edge.fromNodeId) ?? []; list.push(edge.toNodeId); children.set(edge.fromNodeId, list);
  }
  const positioned: PositionedGraphNode[] = [];
  const visited = new Set<string>();
  const append = (root: string): void => {
    const stack = [{ id: root, depth: 0, hidden: false }];
    while (stack.length > 0 && visited.size < 100) {
      const item = stack.pop()!;
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      const childIds = children.get(item.id) ?? [];
      if (!item.hidden) positioned.push({ node: byId.get(item.id)!, depth: item.depth,
        x: 24 + item.depth * 272, y: 24 + positioned.length * 92, childCount: childIds.length });
      for (let index = childIds.length - 1; index >= 0; index -= 1) stack.push({ id: childIds[index]!,
        depth: Math.min(99, item.depth + 1), hidden: item.hidden || collapsed.has(item.id) });
    }
  };
  for (const node of nodes) if (!parents.has(node.nodeId)) append(node.nodeId);
  for (const node of nodes) if (!visited.has(node.nodeId)) append(node.nodeId);
  const visible = new Set(positioned.map((item) => item.node.nodeId));
  return { nodes: positioned, edges: edges.filter((edge) => visible.has(edge.fromNodeId) && visible.has(edge.toNodeId)),
    width: Math.max(640, ...positioned.map((item) => item.x + 264)), height: Math.max(320, positioned.length * 92 + 40) };
}
