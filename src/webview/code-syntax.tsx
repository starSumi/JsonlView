import React from 'react';

import { tokenizeCode as tokenizeCodeCore } from './code-syntax-core';
import { tokenizePatch } from './patch-syntax';

export { formatJavaScriptForDisplay, tokenizeCode } from './code-syntax-core';
export { tokenizePatch } from './patch-syntax';
export type {
  CodeSyntaxKind,
  CodeSyntaxOptions,
  CodeSyntaxResult,
  CodeSyntaxToken,
} from './code-syntax-core';

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

  return (
    <>
      {result.truncated ? (
        <div className="content-budget-notice" role="status">
          Syntax preview is limited to the first {result.displayedChars.toLocaleString()} characters.
        </div>
      ) : null}
      <pre className={`content-code${className ? ` ${className}` : ''}`} aria-label={ariaLabel}>
        {result.tokens.map((token, index) => (
          token.kind === 'plain'
            ? <React.Fragment key={index}>{token.text}</React.Fragment>
            : <span className={`code-token code-token-${token.kind}`} key={`${token.kind}:${index}`}>{token.text}</span>
        ))}
      </pre>
    </>
  );
}
