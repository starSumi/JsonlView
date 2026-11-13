#!/usr/bin/env node
import { createMcpServer, isSourceId, type McpServerSource } from './mcp-server-runtime.js';

interface CliOptions {
  readonly help: boolean;
  readonly sources: readonly McpServerSource[];
  readonly budgetMs?: number;
  readonly maxConcurrency?: number;
}

export function parseMcpCliArgs(args: readonly string[]): CliOptions {
  const sources: McpServerSource[] = [];
  let budgetMs: number | undefined;
  let maxConcurrency: number | undefined;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--source') {
      const value = args[++index];
      const separator = value?.indexOf('=') ?? -1;
      if (value === undefined || separator < 1) throw new TypeError('Each --source must use <id>=<absolute-file-path>.');
      const sourceId = value.slice(0, separator);
      const sourcePath = value.slice(separator + 1);
      if (!isSourceId(sourceId) || sourcePath.length === 0) throw new TypeError('Each --source must use a valid opaque ID and absolute file path.');
      sources.push({ sourceId, sourcePath });
      continue;
    }
    if (arg === '--budget-ms') {
      if (budgetMs !== undefined) throw new TypeError('--budget-ms may only be supplied once.');
      budgetMs = parseBoundedInteger(args[++index], '--budget-ms', 1, 60_000);
      continue;
    }
    if (arg === '--max-concurrency') {
      if (maxConcurrency !== undefined) throw new TypeError('--max-concurrency may only be supplied once.');
      maxConcurrency = parseBoundedInteger(args[++index], '--max-concurrency', 1, 8);
      continue;
    }
    throw new TypeError('Unknown command-line option. Use --help for usage.');
  }
  if (help) return { help, sources: [] };
  if (sources.length === 0 || sources.length > 64) throw new TypeError('Register between 1 and 64 sources with --source.');
  if (new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length) throw new TypeError('Source IDs must be unique.');
  return { help, sources, ...(budgetMs === undefined ? {} : { budgetMs }), ...(maxConcurrency === undefined ? {} : { maxConcurrency }) };
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseMcpCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`JsonlView MCP CLI configuration is invalid: ${safeMessage(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write('Usage: jsonlview-mcp --source <opaque-id>=<absolute-file-path> [--source <id>=<path> ...] [--budget-ms 1..60000] [--max-concurrency 1..8]\n');
    return;
  }
  try {
    const server = await createMcpServer({
      sources: options.sources,
      input: process.stdin,
      output: process.stdout,
      limits: { ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }), ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }) },
    });
    process.once('SIGINT', () => stopForSignal(server, 'SIGINT'));
    process.once('SIGTERM', () => stopForSignal(server, 'SIGTERM'));
    server.start();
  } catch (error) {
    // Filesystem exceptions may include the supplied path, so keep start failures fixed-schema.
    process.stderr.write('JsonlView MCP CLI could not start: source registration failed.\n');
    process.exitCode = 2;
  }
}

function stopForSignal(server: Awaited<ReturnType<typeof createMcpServer>>, signal: 'SIGINT' | 'SIGTERM'): void {
  server.stop();
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  process.stdin.destroy();
  process.stdout.end();
}

function parseBoundedInteger(raw: string | undefined, name: string, minimum: number, maximum: number): number {
  if (raw === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new TypeError(`${name} must be a decimal integer from ${minimum} through ${maximum}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be a decimal integer from ${minimum} through ${maximum}.`);
  return value;
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'invalid arguments';
  // Filesystem exceptions can contain absolute paths; keep diagnostics path-free.
  return error.name === 'TypeError' ? error.message : 'source registration failed';
}

void main();
