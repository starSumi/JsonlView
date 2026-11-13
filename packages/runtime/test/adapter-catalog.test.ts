import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_ADAPTERS, findBuiltinAgentAdapter, validateAgentAdapterDescriptor, validatePluginCatalogEntry } from '../src/adapter-catalog.js';

const acpDescriptor = {
  schema: 'jsonlview.agent-adapter.v1',
  id: 'example.acp',
  protocol: 'acp',
  protocolVersions: ['1'],
  transports: ['stdio'],
  executionTargets: ['local'],
  capabilities: ['acp.prompt'],
  provenance: { kind: 'builtin', sourceId: 'jsonlview' },
};

describe('agent adapter catalog', () => {
  it('accepts a bounded ACP descriptor without executable configuration', () => {
    expect(validateAgentAdapterDescriptor(acpDescriptor)).toEqual(acpDescriptor);
  });

  it('ships generic ACP v1 and read-only JsonlView MCP entries as metadata-only built-ins', () => {
    expect(BUILTIN_AGENT_ADAPTERS.map(({ id, protocol }) => ({ id, protocol }))).toEqual([
      { id: 'generic.acp-v1', protocol: 'acp' },
      { id: 'jsonlview.mcp-read-only', protocol: 'mcp' },
    ]);
    expect(findBuiltinAgentAdapter('jsonlview.mcp-read-only')?.capabilities).toContain('mcp.tools.call.read-only');
    expect(Object.isFrozen(BUILTIN_AGENT_ADAPTERS[0]?.protocolVersions)).toBe(true);
  });

  it('accepts MCP stdio and Streamable HTTP as protocol transports independent of targets', () => {
    expect(validateAgentAdapterDescriptor({
      schema: 'jsonlview.agent-adapter.v1',
      id: 'example.mcp',
      protocol: 'mcp',
      protocolVersions: ['2025-11-25', '2026-07-28'],
      transports: ['stdio', 'streamable-http'],
      executionTargets: ['local', 'wsl', 'ssh'],
      capabilities: ['mcp.tools.list', 'mcp.tools.call'],
      provenance: { kind: 'provider', sourceId: 'example-provider', revision: 'v1.2.3', digestSha256: 'a'.repeat(64) },
    })).toMatchObject({ protocol: 'mcp', transports: ['stdio', 'streamable-http'], executionTargets: ['local', 'wsl', 'ssh'] });
  });

  it('rejects unknown schemas, versions, unsupported transport and execution target combinations', () => {
    expect(() => validateAgentAdapterDescriptor({ ...acpDescriptor, schema: 'vendor.plugin.v1' })).toThrow(/schema/u);
    expect(() => validateAgentAdapterDescriptor({ ...acpDescriptor, protocolVersions: ['999'] })).toThrow(/protocol version/u);
    expect(() => validateAgentAdapterDescriptor({ ...acpDescriptor, transports: ['websocket'] })).toThrow(/transport/u);
    expect(() => validateAgentAdapterDescriptor({ ...acpDescriptor, executionTargets: ['bridge'] })).toThrow(/execution target/u);
  });

  it('rejects executable, environment and credential fields in catalog descriptors', () => {
    expect(() => validateAgentAdapterDescriptor({ ...acpDescriptor, command: 'cmd.exe' })).toThrow(/unexpected field/iu);
    expect(() => validateAgentAdapterDescriptor({ ...acpDescriptor, env: { TOKEN: 'secret' } })).toThrow(/unexpected field/iu);
    expect(() => validateAgentAdapterDescriptor({ ...acpDescriptor, credentialRef: 'secret://agent' })).toThrow(/unexpected field/iu);
  });

  it('accepts a pinned plugin catalog reference but never defaults it to enabled', () => {
    const entry = validatePluginCatalogEntry({
      schema: 'jsonlview.plugin-catalog-entry.v1',
      id: 'example.tools',
      publisher: 'Example Publisher',
      source: { uri: 'https://example.com/example/tools', revision: 'a'.repeat(40), digestSha256: 'b'.repeat(64) },
      adapterIds: ['example.mcp'],
      skills: [{ id: 'review', relativePath: 'skills/review/SKILL.md' }],
    });

    expect(entry.enabled).toBe(false);
    expect(entry.adapterIds).toEqual(['example.mcp']);
  });

  it('rejects mutable or unsafe plugin source paths and duplicate identities', () => {
    expect(() => validatePluginCatalogEntry({
      schema: 'jsonlview.plugin-catalog-entry.v1',
      id: 'example.tools',
      publisher: 'Example Publisher',
      source: { uri: 'https://example.com/example/tools', revision: 'main', digestSha256: 'b'.repeat(64) },
      adapterIds: [], skills: [],
    })).toThrow(/immutable commit SHA/u);
    expect(() => validatePluginCatalogEntry({
      schema: 'jsonlview.plugin-catalog-entry.v1',
      id: 'example.tools',
      publisher: 'Example Publisher',
      source: { uri: 'https://example.com/example/tools', revision: 'a'.repeat(39), digestSha256: 'b'.repeat(64) },
      adapterIds: [], skills: [],
    })).toThrow(/40-character immutable commit SHA/u);
    expect(() => validatePluginCatalogEntry({
      schema: 'jsonlview.plugin-catalog-entry.v1',
      id: 'example.tools',
      publisher: 'Example Publisher',
      source: { uri: 'https://user:secret@example.com/tools', revision: 'a'.repeat(40), digestSha256: 'b'.repeat(64) },
      adapterIds: [], skills: [],
    })).toThrow(/inline credentials/u);
    expect(() => validatePluginCatalogEntry({
      schema: 'jsonlview.plugin-catalog-entry.v1',
      id: 'example.tools',
      publisher: 'Example Publisher',
      source: { uri: 'https://example.com/example/tools', revision: 'a'.repeat(40), digestSha256: 'b'.repeat(64) },
      adapterIds: ['example.mcp', 'example.mcp'], skills: [],
    })).toThrow(/duplicate/iu);
    expect(() => validatePluginCatalogEntry({
      schema: 'jsonlview.plugin-catalog-entry.v1',
      id: 'example.tools',
      publisher: 'Example Publisher',
      source: { uri: 'https://example.com/example/tools', revision: 'a'.repeat(40), digestSha256: 'b'.repeat(64) },
      adapterIds: [], skills: [{ id: 'review', relativePath: '../outside.md' }],
    })).toThrow(/relative path/iu);
    expect(() => validatePluginCatalogEntry({
      schema: 'jsonlview.plugin-catalog-entry.v1',
      id: 'example.tools',
      publisher: 'Example Publisher',
      source: { uri: 'https://example.com/example/tools', revision: 'a'.repeat(40), digestSha256: 'b'.repeat(64) },
      adapterIds: [], skills: [{ id: 'review', relativePath: 'C:/outside.md' }],
    })).toThrow(/relative path/iu);
  });
});
