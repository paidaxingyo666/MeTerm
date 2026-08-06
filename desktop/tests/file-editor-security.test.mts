import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isImageFile,
  renderMarkdown,
} from '../src/file-editor-md.ts';
import {
  editorTextFitsLimit,
  isSafeEditorWindowLabel,
  isValidEditorNonce,
  purgeLegacyEditorStorage,
} from '../src/file-editor-events.ts';

test('SVG files are rendered as text rather than active image documents', () => {
  assert.equal(isImageFile('diagram.svg'), false);
  assert.equal(isImageFile('photo.png'), true);
});

test('Markdown preview blocks remote image tracking but keeps safe links', () => {
  const remoteImage = renderMarkdown('![pixel](https://tracker.example/pixel.png)');
  assert.doesNotMatch(remoteImage, /<img\b/i);

  const link = renderMarkdown('[docs](https://example.com/help)');
  assert.match(link, /<a href="https:\/\/example\.com\/help"/);

  const dataImage = renderMarkdown('![local](data:image/png;base64,iVBORw0KGgo=)');
  assert.match(dataImage, /<img\b/);
});

test('Editor routing accepts only bounded labels and random nonces', () => {
  assert.equal(isSafeEditorWindowLabel('window-123_main'), true);
  assert.equal(isSafeEditorWindowLabel('../main'), false);
  assert.equal(isValidEditorNonce('8de5a4ac-f8d3-4ef2-b081-84ad4736ecaf'), true);
  assert.equal(isValidEditorNonce('session::/etc/passwd'), false);
  assert.equal(editorTextFitsLimit('small file'), true);
});

test('legacy editor content is purged without deleting preferences', () => {
  const values = new Map<string, string>([
    ['meterm-editor-content-old-tab', 'secret'],
    ['meterm-editor-savereq-old-tab', 'secret'],
    ['meterm-editor-pending', 'secret'],
    ['meterm-editor-font-size', '14'],
    ['meterm-editor-window-size', '{"width":960,"height":680}'],
  ]);
  const storage = {
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    removeItem(key: string) { values.delete(key); },
  };
  purgeLegacyEditorStorage(storage);
  assert.deepEqual([...values.keys()].sort(), [
    'meterm-editor-font-size',
    'meterm-editor-window-size',
  ]);
});
