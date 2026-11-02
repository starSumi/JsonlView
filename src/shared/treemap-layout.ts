import { TREEMAP_MAX_NODES, TREEMAP_MAX_VALUE_DIGITS, type TreemapNodeV1 } from './treemap';

export interface TreemapRect {
  id: string;
  label: string;
  value: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreemapBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AreaItem {
  node: TreemapNodeV1;
  value: bigint;
  area: number;
  order: number;
}

/**
 * Pure, dependency-free squarified layout for a bounded metadata tree level.
 * Values remain decimal strings in the result while only normalized areas are
 * converted to finite doubles for SVG geometry in normalized local coordinates.
 * Bounds must retain their positive extent at their origin within eight double
 * precision epsilons, and their normalized aspect ratio must be representable.
 * Sub-pixel magnitudes may underflow to zero geometry; exact values are retained.
 * If every positive area underflows, the level is rejected rather than left empty.
 */
export function layoutSquarifiedTreemap(nodes: readonly TreemapNodeV1[], bounds: TreemapBounds): TreemapRect[] {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height) || bounds.width < 0 || bounds.height < 0) throw new Error('Treemap bounds must be finite and non-negative.');
  if (nodes.length > TREEMAP_MAX_NODES) throw new Error('Treemap node limit exceeded.');
  validateEdge(bounds.x, bounds.width);
  validateEdge(bounds.y, bounds.height);
  for (let index = 0; index < nodes.length; index += 1) {
    if (!Object.hasOwn(nodes, index) || nodes[index] == null) throw new Error('Treemap nodes must be a dense level.');
  }

  const result = nodes.map((node) => ({ id: node.id, label: node.label, value: node.value, x: bounds.x, y: bounds.y, width: 0, height: 0 }));
  const items: AreaItem[] = nodes.map((node, order) => {
    const value = parseDecimal(node.value);
    return { node, value, area: 0, order };
  });
  const total = items.reduce((sum, item) => sum + item.value, 0n);
  if (total === 0n || bounds.width === 0 || bounds.height === 0) return result;

  const scale = Math.max(bounds.width, bounds.height);
  const local = { x: 0, y: 0, width: bounds.width / scale, height: bounds.height / scale };
  const totalArea = local.width * local.height;
  if (totalArea === 0) throw new Error('Treemap bounds exceed representable aspect ratio.');
  for (const item of items) item.area = ratio(item.value, total) * totalArea;
  const positive = items.filter((item) => item.area > 0).sort((left, right) => right.area - left.area);
  if (positive.length === 0) throw new Error('Treemap areas exceed representable geometry.');
  const placed = new Map<number, TreemapRect>();
  let remaining = local;
  let row: AreaItem[] = [];
  for (const item of positive) {
    const side = Math.min(remaining.width, remaining.height);
    if (row.length > 0 && worst(row, side) < worst([...row, item], side)) {
      remaining = placeRow(row, remaining, placed, false);
      row = [];
    }
    row.push(item);
  }
  if (row.length > 0) placeRow(row, remaining, placed, true);
  for (const item of items) {
    const rect = placed.get(item.order);
    if (rect !== undefined) result[item.order] = project(rect, bounds, scale);
  }
  return result;
}

function placeRow(row: readonly AreaItem[], bounds: TreemapBounds, placed: Map<number, TreemapRect>, final: boolean): TreemapBounds {
  const area = row.reduce((sum, item) => sum + item.area, 0);
  if (area <= 0) return bounds;
  const horizontal = bounds.width < bounds.height;
  if (horizontal) {
    const height = final ? bounds.height : clamp(area / bounds.width, 0, bounds.height);
    let offset = 0;
    for (const [index, item] of row.entries()) {
      const width = index === row.length - 1 ? bounds.width - offset : clamp((item.area / area) * bounds.width, 0, bounds.width - offset);
      placed.set(item.order, rect(item, bounds.x + offset, bounds.y, width, height));
      offset += width;
    }
    return { ...bounds, y: bounds.y + height, height: Math.max(0, bounds.height - height) };
  } else {
    const width = final ? bounds.width : clamp(area / bounds.height, 0, bounds.width);
    let offset = 0;
    for (const [index, item] of row.entries()) {
      const height = index === row.length - 1 ? bounds.height - offset : clamp((item.area / area) * bounds.height, 0, bounds.height - offset);
      placed.set(item.order, rect(item, bounds.x, bounds.y + offset, width, height));
      offset += height;
    }
    return { ...bounds, x: bounds.x + width, width: Math.max(0, bounds.width - width) };
  }
}

function validateEdge(origin: number, extent: number): void {
  const end = origin + extent;
  if (!Number.isFinite(end) || (extent > 0 && Math.abs((end - origin) / extent - 1) > 8 * Number.EPSILON)) {
    throw new Error('Treemap bounds exceed representable geometry at their origin.');
  }
}

function project(item: TreemapRect, bounds: TreemapBounds, scale: number): TreemapRect {
  const x = clamp(bounds.x + item.x * scale, bounds.x, bounds.x + bounds.width);
  const y = clamp(bounds.y + item.y * scale, bounds.y, bounds.y + bounds.height);
  const right = clamp(bounds.x + (item.x + item.width) * scale, x, bounds.x + bounds.width);
  const bottom = clamp(bounds.y + (item.y + item.height) * scale, y, bounds.y + bounds.height);
  return { ...item, x, y, width: right - x, height: bottom - y };
}

function worst(row: readonly AreaItem[], side: number): number {
  if (row.length === 0 || side <= 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (const item of row) {
    sum += item.area;
    minimum = Math.min(minimum, item.area);
    maximum = Math.max(maximum, item.area);
  }
  if (minimum <= 0 || !Number.isFinite(sum)) return Number.POSITIVE_INFINITY;
  const logSide = Math.log(side);
  const logSum = Math.log(sum);
  return Math.max(2 * logSide + Math.log(maximum) - 2 * logSum, 2 * logSum - 2 * logSide - Math.log(minimum));
}

function rect(item: AreaItem, x: number, y: number, width: number, height: number): TreemapRect {
  return { id: item.node.id, label: item.node.label, value: item.node.value, x, y, width, height };
}

function parseDecimal(value: string): bigint {
  if (typeof value !== 'string' || value.length > TREEMAP_MAX_VALUE_DIGITS
    || !/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error('Treemap values must be bounded non-negative decimal strings.');
  return BigInt(value);
}

function ratio(value: bigint, total: bigint): number {
  if (value === 0n || total === 0n) return 0;
  const left = value.toString();
  const right = total.toString();
  const precision = 15;
  const leftHead = Number(left.slice(0, precision));
  const rightHead = Number(right.slice(0, precision));
  const exponent = Math.max(0, left.length - precision) - Math.max(0, right.length - precision);
  const normalized = (leftHead / rightHead) * 10 ** exponent;
  return Number.isFinite(normalized) ? Math.min(1, Math.max(0, normalized)) : exponent > 0 ? 1 : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 0));
}
