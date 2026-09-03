import React from 'react';
import { Check, Copy } from 'lucide-react';

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // The Webview clipboard may be unavailable until it has focus.
  }

  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.insetInlineStart = '-10000px';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

interface CopyButtonProps {
  text: string;
  label?: string;
}

export function CopyButton({ text, label = 'Copy item' }: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const handleCopy = async (): Promise<void> => {
    const result = await copyText(text);
    setCopied(result);
    setFailed(!result);
    if (result) window.setTimeout(() => setCopied(false), 1_200);
  };

  const Icon = copied ? Check : Copy;
  const status = copied ? 'Copied' : failed ? 'Copy failed' : label;
  return (
    <button
      type="button"
      className="icon-button copy-button"
      title={status}
      aria-label={status}
      disabled={!text}
      onClick={() => void handleCopy()}
    >
      <Icon size={14} aria-hidden />
    </button>
  );
}
