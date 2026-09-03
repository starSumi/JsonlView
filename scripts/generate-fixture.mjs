import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';

const options = parseArgs(process.argv.slice(2));
const outputPath = resolve(options.output);
const output = createWriteStream(outputPath, { encoding: 'utf8' });
const hash = createHash('sha256');
let bytes = 0;

for (let index = 0; index < options.records; index += 1) {
  const line = makeLine(index, options);
  const newline = index === options.records - 1 && options.noFinalNewline
    ? ''
    : options.crlf
      ? '\r\n'
      : '\n';
  const chunk = `${line}${newline}`;
  hash.update(chunk);
  bytes += Buffer.byteLength(chunk);
  if (!output.write(chunk)) {
    await once(output, 'drain');
  }
}

output.end();
await once(output, 'close');
const metadata = await stat(outputPath);

console.log(JSON.stringify({
  output: outputPath,
  profile: options.profile,
  records: options.records,
  requestedPayloadBytes: options.payloadBytes,
  bytes,
  statBytes: metadata.size,
  sha256: hash.digest('hex'),
  crlf: options.crlf,
  noFinalNewline: options.noFinalNewline,
  malformedEvery: options.malformedEvery,
}, null, 2));

function parseArgs(args) {
  const parsed = {
    output: 'fixture.jsonl',
    profile: 'generic',
    records: 1000,
    payloadBytes: 128,
    malformedEvery: 0,
    crlf: false,
    noFinalNewline: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--crlf') {
      parsed.crlf = true;
      continue;
    }
    if (key === '--no-final-newline') {
      parsed.noFinalNewline = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    index += 1;
    switch (key) {
      case '--output':
        parsed.output = value;
        break;
      case '--profile':
        if (!['generic', 'codex', 'claude', 'mixed'].includes(value)) {
          throw new Error(`Unsupported profile: ${value}`);
        }
        parsed.profile = value;
        break;
      case '--records':
        parsed.records = positiveInteger(value, key);
        break;
      case '--payload-bytes':
        parsed.payloadBytes = nonNegativeInteger(value, key);
        break;
      case '--malformed-every':
        parsed.malformedEvery = nonNegativeInteger(value, key);
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }
  return parsed;
}

function positiveInteger(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return result;
}

function nonNegativeInteger(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return result;
}

function makeLine(index, settings) {
  if (settings.malformedEvery > 0 && (index + 1) % settings.malformedEvery === 0) {
    return `{"broken":${index}`;
  }
  const profile = settings.profile === 'mixed'
    ? ['generic', 'codex', 'claude'][index % 3]
    : settings.profile;
  switch (profile) {
    case 'codex':
      return JSON.stringify(makeCodex(index, settings.payloadBytes));
    case 'claude':
      return JSON.stringify(makeClaude(index, settings.payloadBytes));
    default:
      return JSON.stringify(makeGeneric(index, settings.payloadBytes));
  }
}

function makeGeneric(index, payloadBytes) {
  return {
    id: index + 1,
    timestamp: timestamp(index),
    level: ['debug', 'info', 'warn', 'error'][index % 4],
    message: `Synthetic event ${index + 1}`,
    nested: {
      region: ['apac', 'eu', 'us'][index % 3],
      latencyMs: (index * 17) % 2000,
    },
    tags: [`batch-${Math.floor(index / 100)}`, `slot-${index % 10}`],
    payload: fixedPayload(index, payloadBytes),
    ...(index > 0 && index % 500 === 0 ? { schemaV2: true, optionalValue: index } : {}),
  };
}

function makeCodex(index, payloadBytes) {
  const kinds = ['session_meta', 'turn_context', 'response_item', 'event_msg'];
  const type = kinds[index % kinds.length];
  const base = {
    timestamp: timestamp(index),
    ordinal: index + 1,
    type,
  };
  if (type === 'session_meta') {
    return { ...base, payload: { id: 'session-fixture', cwd: 'C:/redacted', model: 'fixture-model' } };
  }
  if (type === 'turn_context') {
    return { ...base, payload: { turn_id: `turn-${Math.floor(index / 4)}`, model: 'fixture-model' } };
  }
  if (type === 'response_item') {
    const tool = index % 8 === 2;
    return {
      ...base,
      payload: tool
        ? { type: 'function_call', call_id: `call-${index}`, name: 'fixture_tool', arguments: '{}' }
        : { type: 'message', role: index % 2 === 0 ? 'assistant' : 'user', content: [{ type: 'text', text: fixedPayload(index, payloadBytes) }] },
    };
  }
  return { ...base, payload: { type: index % 5 === 0 ? 'error' : 'agent_message', message: fixedPayload(index, payloadBytes) } };
}

function makeClaude(index, payloadBytes) {
  const tool = index % 5 === 2;
  const result = index % 5 === 3;
  return {
    type: tool ? 'assistant' : result ? 'user' : index % 2 === 0 ? 'assistant' : 'user',
    uuid: `message-${index}`,
    parentUuid: index > 0 ? `message-${index - 1}` : null,
    timestamp: timestamp(index),
    message: {
      role: tool ? 'assistant' : result ? 'user' : index % 2 === 0 ? 'assistant' : 'user',
      content: tool
        ? [{ type: 'tool_use', id: `tool-${index}`, name: 'fixture_tool', input: {} }]
        : result
          ? [{ type: 'tool_result', tool_use_id: `tool-${index - 1}`, content: fixedPayload(index, payloadBytes) }]
          : [{ type: 'text', text: fixedPayload(index, payloadBytes) }],
      usage: { input_tokens: index + 10, output_tokens: index + 4 },
    },
  };
}

function fixedPayload(index, size) {
  const prefix = `payload-${index}-`;
  if (prefix.length >= size) {
    return prefix.slice(0, size);
  }
  return `${prefix}${'x'.repeat(size - prefix.length)}`;
}

function timestamp(index) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

