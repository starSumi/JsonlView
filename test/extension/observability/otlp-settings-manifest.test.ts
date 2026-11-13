import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ConfigurationProperty {
  readonly type?: string;
  readonly default?: unknown;
  readonly scope?: string;
  readonly description?: string;
  readonly deprecationMessage?: string;
}

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  contributes?: {
    configuration?: {
      properties?: Record<string, ConfigurationProperty>;
    };
  };
};
const properties = manifest.contributes?.configuration?.properties ?? {};

describe('OTLP setting manifest migration contract', () => {
  it.each([
    {
      canonicalKey: 'jsonlView.telemetry.otlp.enabled',
      legacyKey: 'jsonlview.telemetry.otlp.enabled',
      type: 'boolean',
      defaultValue: false,
    },
    {
      canonicalKey: 'jsonlView.telemetry.otlp.endpoint',
      legacyKey: 'jsonlview.telemetry.otlp.endpoint',
      type: 'string',
      defaultValue: '',
    },
  ])('declares $canonicalKey and deprecates $legacyKey with a pointer to the canonical key', ({ canonicalKey, legacyKey, type, defaultValue }) => {
    expect(properties[canonicalKey]).toMatchObject({
      type,
      default: defaultValue,
      scope: 'machine',
    });
    expect(properties[legacyKey]?.deprecationMessage).toContain(canonicalKey);
  });
});
