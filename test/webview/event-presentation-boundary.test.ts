import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providerSource = readFileSync(
  new URL('../../src/webview/providers/agent-event-presentation.ts', import.meta.url),
  'utf8',
);
const facadeSource = readFileSync(
  new URL('../../src/webview/event-presentation.tsx', import.meta.url),
  'utf8',
);

describe('event presentation module boundaries', () => {
  it('keeps the provider projection independent from TSX rendering facades', () => {
    expect(providerSource).not.toContain("from '../content-view'");
    expect(providerSource).not.toContain("from '../code-syntax'");
    expect(providerSource).not.toContain("from '../json-syntax'");
    expect(providerSource).not.toContain("from 'react'");
    expect(providerSource).toContain("from '../shared/presentation/content-analysis'");
    expect(providerSource).toContain("from '../shared/presentation/code-syntax-core'");
    expect(providerSource).toContain("from '../shared/presentation/json-syntax-core'");
  });

  it('keeps the root facade responsible for the React wrapper and compatibility exports', () => {
    expect(facadeSource).toContain("from './widgets/detail-drawer/AgentEventPresentation'");
    expect(facadeSource).toContain("from './providers/agent-event-presentation'");
  });
});
