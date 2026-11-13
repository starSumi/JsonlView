import { describe, expect, it } from 'vitest';
import { createRuntimeLaunch, createRuntimeProcessFactory, RUNTIME_LIMITS } from '../src/index.js';

describe('runtime process', () => {
  it('streams stdout and settles after exit', async () => {
    const p = createRuntimeProcessFactory({ kind: 'local' })({ command: process.execPath, args: ['-e', "console.log('ok')"] });
    const lines: string[] = [];
    p.onLine((line) => lines.push(line));
    const result = await p.settled;
    expect(lines).toContain('ok');
    expect(result.outcome).toBe('exited');
    expect(result.code).toBe(0);
  });

  it('settles after stop', async () => {
    const p = createRuntimeProcessFactory({ kind: 'local' })({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const result = await p.stop();
    expect(['terminated', 'unknown']).toContain(result.outcome);
  });

  it('settles spawned descendants when the owned process tree is stopped', async () => {
    const childSource = [
      "const { spawn } = require('node:child_process')",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write(JSON.stringify({ grandchildPid: grandchild.pid }) + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const source = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
      "let output = ''",
      "child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('\\n')) { try { const { grandchildPid } = JSON.parse(output.split('\\n')[0]); process.stdout.write(JSON.stringify({ childPid: child.pid, grandchildPid }) + '\\n') } catch {} } })",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const processHandle = createRuntimeProcessFactory({ kind: 'local' })({ command: process.execPath, args: ['-e', source] });
    let descendants: { childPid: number; grandchildPid: number } | undefined;
    processHandle.onLine((line) => {
      try { descendants = JSON.parse(line) as { childPid: number; grandchildPid: number }; } catch { /* Ignore non-fixture output. */ }
    });
    try {
      await expect.poll(() => descendants, { timeout: 3000 }).toBeDefined();
      const result = await processHandle.stop();
      expect(result.outcome).toBe('terminated');
      expect(descendants).toBeDefined();
      expect(isProcessAlive(descendants!.childPid)).toBe(false);
      expect(isProcessAlive(descendants!.grandchildPid)).toBe(false);
    } finally {
      await processHandle.stop();
      for (const pid of descendants === undefined ? [] : [descendants.childPid, descendants.grandchildPid]) {
        if (isProcessAlive(pid)) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* The process may exit between the probe and cleanup. */ }
        }
      }
    }
  });

  it.skipIf(process.platform === 'win32')('waits for SIGKILL escalation when owned descendants ignore SIGTERM', async () => {
    const childSource = [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGTERM', () => {})",
      "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
      "process.stdout.write(JSON.stringify({ grandchildPid: grandchild.pid }) + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const source = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
      "let output = ''",
      "child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('\\n')) { try { const { grandchildPid } = JSON.parse(output.split('\\n')[0]); process.stdout.write(JSON.stringify({ childPid: child.pid, grandchildPid }) + '\\n') } catch {} } })",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const processHandle = createRuntimeProcessFactory({ kind: 'local' })({ command: process.execPath, args: ['-e', source] });
    let descendants: { childPid: number; grandchildPid: number } | undefined;
    processHandle.onLine((line) => {
      try { descendants = JSON.parse(line) as { childPid: number; grandchildPid: number }; } catch { /* Ignore non-fixture output. */ }
    });
    try {
      await expect.poll(() => descendants, { timeout: 3000 }).toBeDefined();
      const startedAt = Date.now();
      const result = await processHandle.stop();
      expect(result.outcome).toBe('terminated');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
      expect(descendants).toBeDefined();
      await expect.poll(() => descendants !== undefined &&
        !isProcessAlive(descendants.childPid) && !isProcessAlive(descendants.grandchildPid), { timeout: 1000 }).toBe(true);
    } finally {
      await processHandle.stop();
      for (const pid of descendants === undefined ? [] : [descendants.childPid, descendants.grandchildPid]) {
        if (isProcessAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* The process may exit between the probe and cleanup. */ }
        }
      }
    }
  });

  it('bounds queued message count, including the in-flight write', async () => {
    const processHandle = createRuntimeProcessFactory({ kind: 'local' })({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    try {
      for (let index = 0; index < RUNTIME_LIMITS.maxQueuedMessages; index++) processHandle.writeLine('x');
      expect(() => processHandle.writeLine('x')).toThrow(/queue is full/iu);
    } finally {
      await processHandle.stop();
    }
  });

  it('preserves local command and argument boundaries in the launch descriptor', () => {
    expect(createRuntimeLaunch({ kind: 'local' }, { command: 'agent executable', args: ['--prompt', 'two words'] })).toMatchObject({
      command: 'agent executable',
      args: ['--prompt', 'two words'],
    });
  });

  it('wraps WSL execution with the selected distribution and an argument boundary', () => {
    expect(createRuntimeLaunch({ kind: 'wsl', distribution: 'Ubuntu-24.04' }, { command: 'agent', args: ['--prompt', 'two words'] })).toMatchObject({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu-24.04', '--', 'agent', '--prompt', 'two words'],
    });
    expect(() => createRuntimeLaunch({ kind: 'wsl', distribution: 'Ubuntu-24.04' }, {
      command: 'agent', args: [], cwd: 'C:\\workspace',
    })).toThrow(/mapped guest working directory/iu);
  });

  it('quotes the remote command for SSH and rejects option-like or whitespace hosts', () => {
    expect(createRuntimeLaunch({ kind: 'ssh', host: 'user@example.org' }, { command: 'agent', args: ['--prompt', "it's fine"] })).toMatchObject({
      command: 'ssh',
      args: ['-o', 'BatchMode=yes', '--', 'user@example.org', "'agent' '--prompt' 'it'\\''s fine'"],
    });
    expect(() => createRuntimeLaunch({ kind: 'ssh', host: '-oProxyCommand=evil' }, { command: 'agent', args: [] })).toThrow(/runtime target/iu);
    expect(() => createRuntimeLaunch({ kind: 'ssh', host: 'user@remote host' }, { command: 'agent', args: [] })).toThrow(/runtime target/iu);
    expect(() => createRuntimeLaunch({ kind: 'ssh', host: 'remote.example' }, { command: 'agent', args: [], cwd: 'C:\\work' })).toThrow(/working directory/iu);
    expect(() => createRuntimeLaunch({ kind: 'ssh', host: 'remote.example' }, { command: 'agent', args: [], env: { TOKEN: 'value' } })).toThrow(/environment/iu);
  });

  it('rejects bridge process launch before spawning a child', () => {
    expect(() => createRuntimeLaunch({ kind: 'bridge', url: 'wss://agent.example/acp', tokenEnv: 'JSONLVIEW_TOKEN' }, {
      command: 'agent', args: [],
    })).toThrow(/protocol-specific client transport/iu);
  });

  it('preserves a UTF-8 code point split across stdout chunks', async () => {
    const text = '中文🧭';
    const bytes = Buffer.from(`${text}\n`, 'utf8');
    const split = bytes.indexOf(Buffer.from('🧭', 'utf8')) + 2;
    const script = [
      `process.stdout.write(Buffer.from([${[...bytes.subarray(0, split)].join(',')}]))`,
      `setTimeout(() => process.stdout.write(Buffer.from([${[...bytes.subarray(split)].join(',')} ])), 20)`,
    ].join(';');
    const processHandle = createRuntimeProcessFactory({ kind: 'local' })({ command: process.execPath, args: ['-e', script] });
    const lines: string[] = [];
    processHandle.onLine((line) => lines.push(line));
    await processHandle.settled;
    expect(lines).toContain(text);
  });

  it('emits a final stdout line when the child exits without a newline', async () => {
    const processHandle = createRuntimeProcessFactory({ kind: 'local' })({ command: process.execPath, args: ['-e', "process.stdout.write('final-line')"] });
    const lines: string[] = [];
    processHandle.onLine((line) => lines.push(line));
    await processHandle.settled;
    expect(lines).toEqual(['final-line']);
  });
});

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
