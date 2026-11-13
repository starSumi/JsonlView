import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const surfaceSource = readFileSync(
  new URL('../../src/webview/features/workspace/WorkspaceSurface.tsx', import.meta.url),
  'utf8',
);
const appSource = readFileSync(
  new URL('../../src/webview/App.tsx', import.meta.url),
  'utf8',
);

describe('workspace surface presentation boundary', () => {
  it('keeps host protocol, query controller, and reducer ownership in App', () => {
    expect(surfaceSource).not.toMatch(/(?:protocol-client|row-query-controller)/u);
    expect(surfaceSource).not.toMatch(/\b(?:workspaceReducer|useReducer|dispatch)\b/u);
    expect(surfaceSource).toContain('export interface WorkspaceSurfaceProps');
    expect(appSource).toContain("from '@features/workspace/WorkspaceSurface'");
    expect(appSource).toContain('<WorkspaceSurface');
  });
});
