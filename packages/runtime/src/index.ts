import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';

export * from './adapter-catalog.js';

export type RuntimeTarget =
  | { readonly kind: 'local' }
  | { readonly kind: 'wsl'; readonly distribution: string }
  | { readonly kind: 'ssh'; readonly host: string }
  | { readonly kind: 'bridge'; readonly url: string; readonly tokenEnv: string };

export interface RuntimeProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RuntimeLaunchDescriptor extends RuntimeProcessSpec {}

export interface RuntimeSettlement {
  readonly outcome: 'exited' | 'terminated' | 'unknown';
  readonly code?: number | null;
  readonly signal?: string | null;
}

export interface RuntimeLineProcess {
  writeLine(line: string): void;
  onLine(fn: (line: string) => void): () => void;
  onStderr(fn: (line: string) => void): () => void;
  onExit(fn: (error?: Error) => void): () => void;
  kill(): void;
  readonly settled: Promise<RuntimeSettlement>;
  stop(): Promise<RuntimeSettlement>;
}

export type RuntimeProcessFactory = (spec: RuntimeProcessSpec) => RuntimeLineProcess;

export const RUNTIME_LIMITS = Object.freeze({ maxFrameBytes: 1_048_576, maxQueuedMessages: 64, maxQueuedBytes: 4_194_304 });

const PROCESS_GROUP_TERM_GRACE_MS = 750;
const PROCESS_GROUP_KILL_WAIT_MS = 2_500;
const PROCESS_STOP_TIMEOUT_MS = 4_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 3_000;

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0');

export function validateRuntimeTarget(value: unknown): RuntimeTarget {
  if (typeof value !== 'object' || value === null || !('kind' in value)) throw new Error('Invalid runtime target');
  const target = value as Record<string, unknown>;
  if (target.kind === 'local') return { kind: 'local' };
  if (target.kind === 'wsl' && typeof target.distribution === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(target.distribution)) {
    return { kind: 'wsl', distribution: target.distribution };
  }
  if (target.kind === 'ssh' && typeof target.host === 'string' && isSshHost(target.host)) {
    return { kind: 'ssh', host: target.host };
  }
  if (target.kind === 'bridge' && typeof target.url === 'string' && typeof target.tokenEnv === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(target.tokenEnv)) {
    let url: URL;
    try { url = new URL(target.url); } catch { throw new Error('Invalid bridge runtime URL'); }
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Bridge runtime URL must use WebSocket');
    if (url.username.length > 0 || url.password.length > 0) throw new Error('Bridge runtime URL must not contain credentials');
    return { kind: 'bridge', url: url.toString(), tokenEnv: target.tokenEnv };
  }
  throw new Error('Invalid runtime target');
}

/** Converts an execution target into a local child-process invocation. */
export function createRuntimeLaunch(targetValue: RuntimeTarget, spec: RuntimeProcessSpec): RuntimeLaunchDescriptor {
  const target = validateRuntimeTarget(targetValue);
  validateProcessSpec(spec);
  const base: RuntimeLaunchDescriptor = {
    command: spec.command,
    args: [...spec.args],
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
  };

  if (target.kind === 'local') return base;
  if (target.kind === 'wsl') {
    if (spec.cwd !== undefined) {
      throw new Error('WSL runtime requires an explicitly mapped guest working directory');
    }
    if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
      throw new Error('WSL runtime does not forward per-process environment values');
    }
    return {
      ...base,
      command: 'wsl.exe',
      args: ['-d', target.distribution, '--', spec.command, ...spec.args],
    };
  }
  if (target.kind === 'ssh') {
    if (spec.cwd !== undefined) throw new Error('SSH runtime does not accept a local working directory');
    if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
      throw new Error('SSH runtime does not forward per-process environment values');
    }
    if ([spec.command, ...spec.args].some((value) => /[\r\n]/u.test(value))) {
      throw new Error('SSH command arguments cannot contain line breaks');
    }
    return {
      command: 'ssh',
      args: ['-o', 'BatchMode=yes', '--', target.host, [spec.command, ...spec.args].map(quoteRemoteArgument).join(' ')],
    };
  }
  throw new Error('Bridge runtime requires a protocol-specific client transport');
}

function validateProcessSpec(spec: RuntimeProcessSpec): void {
  if (!isText(spec.command) || !Array.isArray(spec.args) || spec.args.length > 256 || spec.args.some((argument) => !isText(argument))) {
    throw new Error('Invalid runtime process spec');
  }
  if (spec.cwd !== undefined && (!isText(spec.cwd) || /[\r\n]/u.test(spec.cwd))) throw new Error('Invalid runtime working directory');
  if (spec.env !== undefined) {
    for (const [key, value] of Object.entries(spec.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || (value !== undefined && (typeof value !== 'string' || value.includes('\0')))) {
        throw new Error('Invalid runtime environment');
      }
    }
  }
}

function isSshHost(value: string): boolean {
  return /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(value);
}

function quoteRemoteArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

class NodeProcess implements RuntimeLineProcess {
  private readonly child: ChildProcess;
  private readonly processGroupId: number | undefined;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly stderrListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(error?: Error) => void>();
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly queued: Buffer[] = [];
  private queuedBytes = 0;
  private writing = false;
  private stopped = false;
  private processTreeTermination: Promise<boolean> | undefined;
  readonly settled: Promise<RuntimeSettlement>;

  constructor(target: RuntimeTarget, spec: RuntimeProcessSpec) {
    const launch = createRuntimeLaunch(target, spec);
    const options: SpawnOptions = {
      cwd: launch.cwd,
      env: launch.env === undefined ? process.env : { ...process.env, ...launch.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(target.kind === 'local' && process.platform !== 'win32' ? { detached: true } : {}),
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    };
    this.child = spawn(launch.command, [...launch.args], options);
    this.processGroupId = target.kind === 'local' && process.platform !== 'win32'
      ? this.child.pid
      : undefined;
    if (this.child.stdin === null || this.child.stdout === null || this.child.stderr === null) {
      throw new Error('Runtime process streams unavailable');
    }

    let settle!: (result: RuntimeSettlement) => void;
    this.settled = new Promise((resolve) => { settle = resolve; });
    this.child.stdout.on('data', (chunk: Buffer | string) => this.acceptChunk(chunk, false));
    this.child.stderr.on('data', (chunk: Buffer | string) => this.acceptChunk(chunk, true));
    this.child.stdin.on('error', (error) => this.notifyExit(error));
    this.child.on('error', (error) => {
      this.notifyExit(error);
      settle({ outcome: 'unknown' });
    });
    this.child.on('close', (code, signal) => {
      this.finishStream(false);
      this.finishStream(true);
      settle({ outcome: this.stopped ? 'terminated' : 'exited', code, signal });
      this.notifyExit();
    });
  }

  writeLine(line: string): void {
    if (this.child.stdin === null) throw new Error('Runtime process stdin is unavailable');
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    if (bytes.byteLength > RUNTIME_LIMITS.maxFrameBytes) throw new Error('Runtime frame exceeds limit');
    const pendingMessages = this.queued.length + (this.writing ? 1 : 0);
    if (this.stopped || pendingMessages >= RUNTIME_LIMITS.maxQueuedMessages ||
        this.queuedBytes + bytes.byteLength > RUNTIME_LIMITS.maxQueuedBytes) {
      throw new Error('Runtime output queue is full');
    }
    this.queued.push(bytes);
    this.queuedBytes += bytes.byteLength;
    this.flush();
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  kill(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (process.platform === 'win32' && this.child.pid !== undefined) {
      this.processTreeTermination = this.terminateWindowsProcessTree(this.child.pid);
    } else if (this.processGroupId !== undefined) {
      // Keep the escalation timer referenced: extension-host shutdown must not
      // interrupt the owned process-group cleanup before SIGKILL is sent.
      this.processTreeTermination = this.terminateProcessGroup();
    } else {
      this.child.kill('SIGTERM');
    }
  }

  async stop(): Promise<RuntimeSettlement> {
    this.kill();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = Promise.all([this.settled, this.processTreeTermination ?? Promise.resolve(true)])
        .then(([result, processTreeGone]) => processTreeGone ? result : { outcome: 'unknown' as const });
      return await Promise.race([
        stopped,
        new Promise<RuntimeSettlement>((resolve) => { timeout = setTimeout(() => resolve({ outcome: 'unknown' }), PROCESS_STOP_TIMEOUT_MS); }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private acceptChunk(chunk: Buffer | string, isStderr: boolean): void {
    const decoder = isStderr ? this.stderrDecoder : this.stdoutDecoder;
    const current = isStderr ? this.stderrBuffer : this.stdoutBuffer;
    const text = current + decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    const lines = text.split(/\r?\n/u);
    const remainder = lines.pop() ?? '';
    if (Buffer.byteLength(remainder, 'utf8') > RUNTIME_LIMITS.maxFrameBytes) {
      this.notifyExit(new Error('Runtime frame exceeds limit'));
      this.kill();
      return;
    }
    if (isStderr) this.stderrBuffer = remainder;
    else this.stdoutBuffer = remainder;
    const listeners = isStderr ? this.stderrListeners : this.lineListeners;
    for (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > RUNTIME_LIMITS.maxFrameBytes) {
        this.notifyExit(new Error('Runtime frame exceeds limit'));
        this.kill();
        return;
      }
      for (const listener of listeners) {
        try { listener(line); } catch { /* A consumer cannot break process stream drainage. */ }
      }
    }
  }

  private finishStream(isStderr: boolean): void {
    const decoder = isStderr ? this.stderrDecoder : this.stdoutDecoder;
    const current = isStderr ? this.stderrBuffer : this.stdoutBuffer;
    const finalText = current + decoder.end();
    if (isStderr) this.stderrBuffer = '';
    else this.stdoutBuffer = '';
    if (finalText.length === 0) return;
    if (Buffer.byteLength(finalText, 'utf8') > RUNTIME_LIMITS.maxFrameBytes) {
      this.notifyExit(new Error('Runtime frame exceeds limit'));
      return;
    }
    const line = finalText.endsWith('\r') ? finalText.slice(0, -1) : finalText;
    const listeners = isStderr ? this.stderrListeners : this.lineListeners;
    for (const listener of listeners) {
      try { listener(line); } catch { /* A consumer cannot break process stream drainage. */ }
    }
  }

  private flush(): void {
    if (this.writing || this.stopped || this.child.stdin === null) return;
    const bytes = this.queued.shift();
    if (bytes === undefined) return;
    this.writing = true;
    this.child.stdin.write(bytes, (error?: Error | null) => {
      this.queuedBytes = Math.max(0, this.queuedBytes - bytes.byteLength);
      this.writing = false;
      if (error != null) this.notifyExit(error);
      this.flush();
    });
  }

  private notifyExit(error?: Error): void {
    for (const listener of this.exitListeners) {
      try { listener(error === undefined ? undefined : toError(error)); } catch { /* Exit observers cannot break cleanup. */ }
    }
  }

  private signalProcessGroup(signal: NodeJS.Signals): void {
    const processGroupId = this.processGroupId;
    if (processGroupId === undefined) return;
    try { process.kill(-processGroupId, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.child.kill(signal);
    }
  }

  private async terminateProcessGroup(): Promise<boolean> {
    this.signalProcessGroup('SIGTERM');
    if (await this.waitForProcessGroupExit(PROCESS_GROUP_TERM_GRACE_MS)) return true;
    this.signalProcessGroup('SIGKILL');
    return this.waitForProcessGroupExit(PROCESS_GROUP_KILL_WAIT_MS);
  }

  private terminateWindowsProcessTree(processId: number): Promise<boolean> {
    return new Promise((resolve) => {
      let taskkill: ChildProcess;
      try {
        taskkill = spawn('taskkill', ['/pid', String(processId), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } catch {
        this.child.kill();
        resolve(false);
        return;
      }
      let finished = false;
      const timeout = setTimeout(() => {
        taskkill.kill();
        this.child.kill();
        finish(false);
      }, WINDOWS_TASKKILL_TIMEOUT_MS);
      const finish = (terminated: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(terminated);
      };
      taskkill.once('error', () => {
        this.child.kill();
        finish(false);
      });
      taskkill.once('close', (code) => finish(code === 0));
    });
  }

  private async waitForProcessGroupExit(timeoutMs: number): Promise<boolean> {
    const processGroupId = this.processGroupId;
    if (processGroupId === undefined) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(-processGroupId, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      process.kill(-processGroupId, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
}

export function createRuntimeProcessFactory(target: RuntimeTarget): RuntimeProcessFactory {
  const validatedTarget = validateRuntimeTarget(target);
  if (validatedTarget.kind === 'bridge') throw new Error('Bridge runtime requires a protocol-specific client transport');
  return (spec) => new NodeProcess(validatedTarget, spec);
}
