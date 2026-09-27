import { describe, expect, it } from 'vitest';
import { formatJavaScriptForDisplay, tokenizeCode, tokenizePatch } from '../../src/webview/code-syntax';

describe('bounded code syntax', () => {
  it('lexes common Python snippets without treating quoted comments as comments', () => {
    const result = tokenizeCode('if age >= 18:\n    print("# not a comment")\n# actual comment', 'python');
    expect(result.tokens.filter((token) => token.kind === 'keyword').map((token) => token.text)).toContain('if');
    expect(result.tokens.filter((token) => token.kind === 'string').map((token) => token.text)).toContain('"# not a comment"');
    expect(result.tokens.filter((token) => token.kind === 'comment').map((token) => token.text)).toContain('# actual comment');
  });

  it('handles JavaScript block comments and preserves unknown languages as source', () => {
    const javascript = tokenizeCode('const answer = 42; /* note */', 'typescript');
    expect(javascript.tokens.some((token) => token.kind === 'keyword' && token.text === 'const')).toBe(true);
    expect(javascript.tokens.some((token) => token.kind === 'comment' && token.text === '/* note */')).toBe(true);
    const unknown = tokenizeCode('some <syntax> stays source', 'invented-language');
    expect(unknown.tokens.every((token) => token.kind === 'plain')).toBe(true);
  });

  it('distinguishes command families and useful symbol roles without changing source text', () => {
    const typescript = 'interface RetryDecision { retry: boolean }\nconst result = await Promise.all(tasks.map(run));';
    const result = tokenizeCode(typescript, 'typescript');
    expect(result.tokens.some((token) => token.kind === 'type' && token.text === 'RetryDecision')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'function' && token.text === 'all')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'operator' && token.text.includes('='))).toBe(true);
    expect(result.tokens.map((token) => token.text).join('')).toBe(typescript);

    const powershell = tokenizeCode('$env:Path = $value | ForEach-Object { $_ }', 'powershell');
    expect(powershell.tokens.filter((token) => token.kind === 'variable').map((token) => token.text)).toEqual([
      '$env:Path', '$value', '$_',
    ]);
    expect(tokenizeCode('Get-Date | ForEach-Object { $_ }', 'powershell').tokens
      .filter((token) => token.kind === 'command').map((token) => token.text)).toEqual(['Get-Date', 'ForEach-Object']);
    expect(tokenizeCode("Write-Output 'x' 42; Get-Date; if ($true) { Get-ChildItem }", 'powershell').tokens
      .filter((token) => token.kind === 'command').map((token) => token.text)).toEqual([
      'Write-Output', 'Get-Date', 'Get-ChildItem',
    ]);
  });

  it('highlights an explicit apply_patch envelope with per-file lexical languages', () => {
    const source = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/retry.ts\n@@\n-export function nextRetry(attempt: number) {\n+export function nextRetry(attempt: number) {\n*** End Patch";
    const result = tokenizePatch(source);
    expect(result.truncated).toBe(false);
    expect(result.tokens.some((token) => token.kind === 'patch-meta' && token.text.includes('Update File'))).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'patch-remove')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'patch-add')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'keyword' && token.text === 'export')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'function' && token.text === 'nextRetry')).toBe(true);
    expect(result.tokens.map((token) => token.text).join('')).toBe(source);
  });

  it('highlights added file contents without requiring a unified-diff hunk', () => {
    const source = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/new-file.ts\n+export const answer = 42;\n*** End Patch";
    const result = tokenizePatch(source);
    expect(result.tokens.some((token) => token.kind === 'patch-add')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'keyword' && token.text === 'export')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'keyword' && token.text === 'const')).toBe(true);
    expect(result.tokens.map((token) => token.text).join('')).toBe(source);
  });

  it('falls back to shell lexing when the patch envelope is incomplete', () => {
    const result = tokenizePatch("apply_patch <<'PATCH'\n*** Begin Patch\n+const value = 1");
    expect(result.tokens.some((token) => token.kind === 'patch-meta')).toBe(false);
    expect(result.tokens.map((token) => token.text).join('')).toBe("apply_patch <<'PATCH'\n*** Begin Patch\n+const value = 1");
  });

  it('preserves CRLF patch bytes and bounds token explosion', () => {
    const source = "apply_patch <<'PATCH'\r\n*** Begin Patch\r\n*** Update File: src/worker.ps1\r\n@@\r\n-Write-Output 'old'\r\n+Write-Output 'new'\r\n*** End Patch";
    const patch = tokenizePatch(source);
    expect(patch.tokens.map((token) => token.text).join('')).toBe(source);
    expect(patch.tokens.some((token) => token.kind === 'patch-remove')).toBe(true);

    const longSource = 'name + '.repeat(12_000);
    const bounded = tokenizeCode(longSource, 'javascript', { maxTokens: 4 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.tokens.map((token) => token.text).join('')).toBe(longSource);
  });

  it('caps highlighting while retaining the complete source boundary', () => {
    const result = tokenizeCode('x'.repeat(20), 'python', { maxChars: 8 });
    expect(result.truncated).toBe(true);
    expect(result.displayedChars).toBe(8);
    expect(result.tokens.map((token) => token.text).join('')).toBe('xxxxxxxx');
  });

  it('formats one-line JavaScript tool calls without touching quoted source', () => {
    const source = 'const r = await tools.exec_command({cmd:"git diff -- a b"}); text(r.output);';
    const formatted = formatJavaScriptForDisplay(source);
    expect(formatted).toContain('exec_command({\n');
    expect(formatted).toContain('  cmd:"git diff -- a b"\n');
    expect(formatted).toContain('});\ntext(r.output);');
    expect(formatted).toContain('text(r.output);');
    expect(formatted).not.toContain('\\n');
  });

  it('falls back to the bounded source for pathologically deep JavaScript input', () => {
    const source = `${'{'.repeat(10_000)}${'}'.repeat(10_000)}`;
    expect(formatJavaScriptForDisplay(source)).toBe(source);
  });

  it('formats repeated closing braces without rescanning prior output', () => {
    const formatted = formatJavaScriptForDisplay('x }'.repeat(10_000));
    expect(formatted).toHaveLength(39_999);
    expect(formatted.startsWith('x\n}\nx\n}')).toBe(true);
    expect(formatted.endsWith('x\n}')).toBe(true);
  });
});
