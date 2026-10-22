import React from 'react';

import { tokenizeCode as tokenizeCodeCore } from '../../shared/presentation/code-syntax-core';
import { tokenizePatch } from './patch-syntax';

export { formatJavaScriptForDisplay, tokenizeCode } from '../../shared/presentation/code-syntax-core';
export { tokenizePatch } from './patch-syntax';
export type {
  CodeSyntaxKind,
  CodeSyntaxOptions,
  CodeSyntaxResult,
  CodeSyntaxToken,
} from '../../shared/presentation/code-syntax-core';

interface HighlightedCodeProps {
  source: string;
  language?: string;
  ariaLabel: string;
  className?: string;
  mode?: 'code' | 'patch';
}

export function HighlightedCode({
  source,
  language = '',
  ariaLabel,
  className,
  mode = 'code',
}: HighlightedCodeProps): React.JSX.Element {
  const result = React.useMemo(
    () => (mode === 'patch' ? tokenizePatch(source) : tokenizeCodeCore(source, language)),
    [language, mode, source],
  );
  const tokenKeys = new Map<string, number>();

  return (
    <>
      {result.truncated ? (
        <div className="content-budget-notice" role="status">
          Syntax preview is limited to the first {result.displayedChars.toLocaleString()} characters.
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/useSemanticElements: the preformatted code surface needs its explicit accessible name */}
      <pre className={`content-code${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
        {result.tokens.map((token) => {
          const baseKey = `${token.kind}:${token.text}`;
          const occurrence = tokenKeys.get(baseKey) ?? 0;
          tokenKeys.set(baseKey, occurrence + 1);
          const key = `${baseKey}:${occurrence}`;
          return (
          token.kind === 'plain'
            ? <React.Fragment key={key}>{token.text}</React.Fragment>
            : <span className={`code-token code-token-${token.kind}`} key={key}>{token.text}</span>
          );
        })}
      </pre>
    </>
  );
}
