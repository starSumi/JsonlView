import type { FieldPath, PathToken } from './types';

export interface SemanticFeatureSpec {
  id: string;
  keys: readonly string[];
  weight?: number;
  accepts?: (value: unknown) => boolean;
}

export interface SemanticFeatureMatch {
  id: string;
  key: string;
  value: unknown;
  path: FieldPath;
  score: number;
}

export interface SemanticFeatureOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxMatchesPerFeature?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_NODES = 512;
const DEFAULT_MAX_MATCHES_PER_FEATURE = 8;

/**
 * Finds bounded semantic fields by key meaning rather than array position.
 * Callers provide a vocabulary for their domain; traversal, scoring, cycle
 * handling, and resource limits remain shared across provider adapters.
 */
export function findSemanticFeatures(
  value: unknown,
  specs: readonly SemanticFeatureSpec[],
  options: SemanticFeatureOptions = {},
): SemanticFeatureMatch[] {
  if (specs.length === 0) return [];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxMatchesPerFeature = options.maxMatchesPerFeature ?? DEFAULT_MAX_MATCHES_PER_FEATURE;
  const byKey = new Map<string, SemanticFeatureSpec[]>();
  for (const spec of specs) {
    for (const key of spec.keys) {
      const normalized = normalizeSemanticKey(key);
      if (!normalized) continue;
      const entries = byKey.get(normalized) ?? [];
      entries.push(spec);
      byKey.set(normalized, entries);
    }
  }
  const matches: SemanticFeatureMatch[] = [];
  const matchCounts = new Map<string, number>();
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, path: PathToken[], depth: number): void => {
    if (nodes >= maxNodes || depth > maxDepth) return;
    nodes += 1;
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length && nodes < maxNodes; index += 1) {
        visit(current[index], [...path, { kind: 'index', value: index }], depth + 1);
      }
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (seen.has(current)) return;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      const childPath: PathToken[] = [...path, { kind: 'key', value: key }];
      const candidates = byKey.get(normalizeSemanticKey(key)) ?? [];
      for (const spec of candidates) {
        if (spec.accepts && !spec.accepts(child)) continue;
        const matchesForFeature = matchCounts.get(spec.id) ?? 0;
        if (matchesForFeature >= maxMatchesPerFeature) continue;
        matches.push({
          id: spec.id,
          key,
          value: child,
          path: { tokens: childPath },
          score: featureScore(spec, child, depth + 1),
        });
        matchCounts.set(spec.id, matchesForFeature + 1);
      }
      if (nodes >= maxNodes) break;
      visit(child, childPath, depth + 1);
    }
  };
  visit(value, [], 0);
  return matches.sort((left, right) => right.score - left.score || left.path.tokens.length - right.path.tokens.length || pathKey(left.path).localeCompare(pathKey(right.path)));
}

export function bestSemanticFeature(
  value: unknown,
  specs: readonly SemanticFeatureSpec[],
  options?: SemanticFeatureOptions,
): SemanticFeatureMatch | undefined {
  return findSemanticFeatures(value, specs, options)[0];
}

function normalizeSemanticKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function featureScore(spec: SemanticFeatureSpec, value: unknown, depth: number): number {
  let score = spec.weight ?? 1;
  if (typeof value === 'string' && value.trim().length > 0) score += 0.2;
  else if (Array.isArray(value) && value.length > 0) score += 0.08;
  else if (value !== null && typeof value === 'object') score += 0.04;
  return Math.max(0, score - Math.max(0, depth - 1) * 0.05);
}

function pathKey(path: FieldPath): string {
  return path.tokens.map((token) => `${token.kind}:${String(token.value)}`).join('/');
}
