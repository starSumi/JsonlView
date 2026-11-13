export interface BoundedJsonOptions {
  maxChars?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxChildren?: number;
  maxStringChars?: number;
}

export interface BoundedJsonText {
  text: string;
  truncated: boolean;
}

const OMITTED = Symbol('bounded-json-omitted');
const DEFAULT_MAX_CHARS = 128 * 1024;

function safeProperty(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return '[Unreadable property]';
  }
}

/**
 * Serialize an arbitrary value with explicit node, depth, child, string, and
 * output budgets. This is a presentation projection; it never mutates input.
 */
export function stringifyJsonBounded(
  value: unknown,
  options: BoundedJsonOptions = {},
): BoundedJsonText {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxNodes = Math.max(1, options.maxNodes ?? 1_000);
  const maxDepth = Math.max(0, options.maxDepth ?? 12);
  const maxChildren = Math.max(1, options.maxChildren ?? 100);
  const maxStringChars = Math.max(1, options.maxStringChars ?? 2_048);
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bounded = false;

  const project = (node: unknown, depth: number): unknown | typeof OMITTED => {
    nodes += 1;
    if (nodes > maxNodes) {
      bounded = true;
      return OMITTED;
    }
    if (typeof node === 'string') {
      if (node.length <= maxStringChars) return node;
      bounded = true;
      return node.slice(0, maxStringChars);
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'number') return node;
    if (typeof node === 'bigint') return String(node) + 'n';
    if (typeof node !== 'object') return String(node);
    if (seen.has(node)) {
      bounded = true;
      return '[Circular]';
    }
    if (depth >= maxDepth) {
      bounded = true;
      return OMITTED;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      const projected: unknown[] = [];
      const count = Math.min(node.length, maxChildren);
      for (let index = 0; index < count && nodes <= maxNodes; index += 1) {
        const child = project(node[index], depth + 1);
        if (child !== OMITTED) projected.push(child);
      }
      if (node.length > count) bounded = true;
      return projected;
    }

    const projected: Record<string, unknown> = {};
    let count = 0;
    let hasMore = false;
    for (const key in node as Record<string, unknown>) {
      if (!Object.hasOwn(node, key)) continue;
      if (count >= maxChildren || nodes > maxNodes) {
        hasMore = true;
        break;
      }
      const child = project(safeProperty(node as Record<string, unknown>, key), depth + 1);
      if (child === OMITTED) {
        hasMore = true;
        break;
      }
      projected[key] = child;
      count += 1;
    }
    if (hasMore) bounded = true;
    return projected;
  };

  let text: string;
  try {
    const projected = project(value, 0);
    text = JSON.stringify(projected === OMITTED ? null : projected, null, 2) ?? String(value);
  } catch {
    return { text: 'Value cannot be serialized.', truncated: true };
  }
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated: bounded };
}
