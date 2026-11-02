import { describe, expect, it } from 'vitest';
import { layoutSquarifiedTreemap, type TreemapBounds } from '../../src/shared/treemap-layout';
import type { TreemapNodeV1 } from '../../src/shared/treemap';

describe('squarified Treemap geometry', () => {
  it('preserves proportional area, duplicate IDs and compact squares in a square viewport', () => {
    const equal = layoutSquarifiedTreemap(Array.from({ length: 4 }, () => ({ id: 'duplicate', label: 'Same', value: '1' })),
      { x: 0, y: 0, width: 100, height: 100 });
    for (const item of equal) {
      expect(item.width).toBeCloseTo(50, 6);
      expect(item.height).toBeCloseTo(50, 6);
    }
    expect(new Set(equal.map((item) => `${String(item.x)}:${String(item.y)}`)).size).toBe(4);
    const proportional = layoutSquarifiedTreemap([
      { id: 'small', label: 'Small', value: '1' }, { id: 'large', label: 'Large', value: '9' },
    ], { x: 10, y: 20, width: 100, height: 100 });
    expect(proportional[0]!.width * proportional[0]!.height).toBeCloseTo(1000, 6);
    expect(proportional[1]!.width * proportional[1]!.height).toBeCloseTo(9000, 6);
  });

  it('returns finite, bounded rectangles for zero, duplicate and very large decimal values', () => {
    const layout = layoutSquarifiedTreemap([
      { id: 'zero', label: 'Zero', value: '0' },
      { id: 'a', label: 'A', value: '900719925474099312345678901234567890' },
      { id: 'b', label: 'B', value: '900719925474099312345678901234567890' },
      { id: 'tiny', label: 'Tiny', value: '1' },
    ], { x: 0, y: 0, width: 640, height: 320 });

    expect(layout).toHaveLength(4);
    expect(layout.map(({ id }) => id)).toEqual(['zero', 'a', 'b', 'tiny']);
    for (const item of layout) {
      expect([item.x, item.y, item.width, item.height].every(Number.isFinite)).toBe(true);
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.width).toBeGreaterThanOrEqual(0);
      expect(item.height).toBeGreaterThanOrEqual(0);
      expect(item.x + item.width).toBeLessThanOrEqual(640.000001);
      expect(item.y + item.height).toBeLessThanOrEqual(320.000001);
    }
    expect(layout[0]).toMatchObject({ width: 0, height: 0 });
    expect(layout[1]!.width * layout[1]!.height).toBeCloseTo(layout[2]!.width * layout[2]!.height, 5);
    expect(layout.reduce((sum, item) => sum + item.width * item.height, 0)).toBeCloseTo(640 * 320, 5);
  });

  it('preserves all 500 inputs without mutation, overlap, or unfilled area', () => {
    const nodes = Array.from({ length: 500 }, (_, index) => ({ id: String(index), label: 'Node', value: String(index + 1) }));
    const before = JSON.stringify(nodes);
    const bounds = { x: 15, y: 40, width: 640, height: 320 };
    const layout = layoutSquarifiedTreemap(nodes, bounds);
    expect(JSON.stringify(nodes)).toBe(before);
    expect(layout).toHaveLength(500);
    expect(layoutSquarifiedTreemap(nodes, bounds)).toEqual(layout);
    expect(layout.reduce((sum, item) => sum + item.width * item.height, 0)).toBeCloseTo(640 * 320, 5);
    for (let index = 0; index < layout.length; index += 1) {
      const left = layout[index]!;
      for (const right of layout.slice(index + 1)) {
        const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
        const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
        expect(width * height).toBeLessThan(1e-7);
      }
    }
  });

  it('handles empty and zero-only inputs, and decimal magnitudes beyond finite Number range', () => {
    expect(layoutSquarifiedTreemap([], { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
    expect(layoutSquarifiedTreemap([{ id: 'zero', label: 'Zero', value: '0' }], {
      x: 20, y: 30, width: 100, height: 100,
    })).toEqual([{ id: 'zero', label: 'Zero', value: '0', x: 20, y: 30, width: 0, height: 0 }]);
    const huge = '9'.repeat(1024);
    const layout = layoutSquarifiedTreemap([
      { id: 'a', label: 'A', value: huge }, { id: 'b', label: 'B', value: huge },
    ], { x: 0, y: 0, width: 100, height: 100 });
    expect(layout[0]!.width * layout[0]!.height).toBeCloseTo(5000, 5);
    expect(layout[1]!.width * layout[1]!.height).toBeCloseTo(5000, 5);
  });

  it('handles an empty rectangle and rejects negative, unsafe, or over-limit input', () => {
    expect(layoutSquarifiedTreemap([{ id: 'a', label: 'A', value: '1' }], {
      x: 0, y: 0, width: 0, height: 20,
    })[0]).toMatchObject({ width: 0, height: 0 });
    expect(() => layoutSquarifiedTreemap([{ id: 'a', label: 'A', value: '-1' }], {
      x: 0, y: 0, width: 20, height: 20,
    })).toThrow();
    expect(() => layoutSquarifiedTreemap([{ id: 'a', label: 'A', value: Number.MAX_SAFE_INTEGER + 1 as unknown as string }], {
      x: 0, y: 0, width: 20, height: 20,
    })).toThrow();
    expect(() => layoutSquarifiedTreemap(Array.from({ length: 501 }, (_, index) => ({
      id: `n-${String(index)}`, label: 'Node', value: '1',
    })), { x: 0, y: 0, width: 20, height: 20 })).toThrow();
    expect(() => layoutSquarifiedTreemap([{ id: 'a', label: 'A', value: '9'.repeat(1025) }], {
      x: 0, y: 0, width: 20, height: 20,
    })).toThrow();
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => layoutSquarifiedTreemap([], { x: 0, y: 0, width: invalid, height: 20 })).toThrow();
    }
  });

  it('covers representable tiny, narrow, transposed and huge bounds without overlap', () => {
    const nodes = [{ id: 'a', label: 'A', value: '1' }, { id: 'b', label: 'B', value: '1' }];
    const cases: TreemapBounds[] = [
      { x: 0, y: 0, width: 1e-20, height: 1 },
      { x: 0, y: 0, width: 1, height: 1e-20 },
      { x: 0, y: 0, width: 1e-200, height: 1e-200 },
      { x: 0, y: 0, width: 1e200, height: 1e200 },
      { x: 1e20, y: -1e20, width: 1e20, height: 1e20 },
    ];
    for (const bounds of cases) {
      const normalized = layoutSquarifiedTreemap(nodes, bounds).map((item) => ({
        x: (item.x - bounds.x) / bounds.width,
        y: (item.y - bounds.y) / bounds.height,
        width: item.width / bounds.width,
        height: item.height / bounds.height,
      }));
      for (const item of normalized) {
        expect([item.x, item.y, item.width, item.height].every(Number.isFinite)).toBe(true);
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.x + item.width).toBeLessThanOrEqual(1 + 1e-12);
        expect(item.y + item.height).toBeLessThanOrEqual(1 + 1e-12);
        expect(item.width * item.height).toBeCloseTo(0.5, 12);
      }
      const [left, right] = normalized;
      const intersectionWidth = Math.max(0, Math.min(left!.x + left!.width, right!.x + right!.width) - Math.max(left!.x, right!.x));
      const intersectionHeight = Math.max(0, Math.min(left!.y + left!.height, right!.y + right!.height) - Math.max(left!.y, right!.y));
      expect(intersectionWidth * intersectionHeight).toBeLessThanOrEqual(1e-12);
      expect(normalized.reduce((sum, item) => sum + item.width * item.height, 0)).toBeCloseTo(1, 12);
    }
  });

  it('rejects nonempty bounds whose positive edges cannot be represented at their origin', () => {
    const nodes = [{ id: 'a', label: 'A', value: '1' }, { id: 'b', label: 'B', value: '1' }];
    for (const bounds of [
      { x: 1e20, y: 0, width: 100, height: 100 },
      { x: 0, y: -1e20, width: 100, height: 100 },
    ]) expect(() => layoutSquarifiedTreemap(nodes, bounds)).toThrow();
  });

  it('rejects a positive level when every normalized area underflows', () => {
    const nodes = [{ id: 'a', label: 'A', value: '1' }, { id: 'b', label: 'B', value: '1' }];
    expect(() => layoutSquarifiedTreemap(nodes, { x: 0, y: 0, width: Number.MIN_VALUE, height: 1 })).toThrow();
  });

  it('rejects sparse node levels instead of returning sparse geometry', () => {
    for (const nodes of [Array(1), Object.assign(Array(2), { 1: { id: 'a', label: 'A', value: '1' } }), [undefined], [null]]) {
      expect(() => layoutSquarifiedTreemap(nodes as TreemapNodeV1[], { x: 0, y: 0, width: 100, height: 100 })).toThrow();
    }
  });
});
