import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TemporaryPreviewActions } from '../../src/webview/temporary-preview-actions';

it('discloses current-session recovery, offers Save As and keeps the original temporary after saving a copy', () => {
  const props = { status: { status: 'temporary' as const, recordCount: 2, sizeBytes: 32, savedCopy: false }, onSaveAs: () => {} };
  const temporary = renderToStaticMarkup(<TemporaryPreviewActions {...props} />);
  expect(temporary).toContain('Temporary'); expect(temporary).toContain('Save As…');
  expect(temporary).toContain('temporary-preview-badge');
  expect(temporary).toContain('Recent Previews during this VS Code session');
  const saving = renderToStaticMarkup(<TemporaryPreviewActions {...props} status={{ ...props.status, status: 'saving' }} />);
  expect(saving).toContain('disabled'); expect(saving).toContain('Saving…');
  const saved = renderToStaticMarkup(<TemporaryPreviewActions {...props} status={{ ...props.status, status: 'saved', savedCopy: true }} />);
  expect(saved).toContain('Temporary · copy saved'); expect(saved).not.toContain('disabled');
});
