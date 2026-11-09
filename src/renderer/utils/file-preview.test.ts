import { absoluteViewPath, chatLinkPath, isFileScopeDenied, openLocalFileLink } from './file-preview';
import { useFilePreviewStore } from '../stores/filePreviewStore';

it('recognizes scope denial wrapped by Electron without confusing OS failures', () => {
  expect(isFileScopeDenied(new Error('Error invoking remote method: Error: Access denied: path "/p/link" is outside allowed project directories'))).toBe(true);
  expect(isFileScopeDenied(new Error('Path traversal is not allowed'))).toBe(true);
  for (const message of ['EACCES: permission denied', 'ENOENT: missing', 'File too large', 'Not a regular file']) {
    expect(isFileScopeDenied(new Error(message))).toBe(false);
  }
});

it('keeps host absolute paths and joins relative worktree paths', () => {
  expect(absoluteViewPath('/scratch/worktree', 'a.ts')).toBe('/scratch/worktree/a.ts');
  expect(absoluteViewPath('/project', '/scratch/a.ts')).toBe('/scratch/a.ts');
  expect(absoluteViewPath('C:\\project', 'D:\\scratch\\a.ts')).toBe('D:\\scratch\\a.ts');
  expect(absoluteViewPath('/project', '~/scratch/a.ts')).toBe('~/scratch/a.ts');
});

it('does not turn web, network, relative, anchor or executable URLs into local previews', () => {
  useFilePreviewStore.getState().close();
  for (const href of ['https://example.test/a', '//host/share/a', './notes.md', '#section', 'javascript:alert(1)', 'data:text/html,test']) {
    expect(openLocalFileLink(href)).toBe(false);
  }
  expect(useFilePreviewStore.getState().target).toBeNull();
});

it('treats relative, absolute and Windows-style chat links as paths, and nothing else (#3189)', () => {
  for (const href of ['Some/Folder/', 'Some/Folder/00_Summary.md', './notes.md', '../up.md', 'Some\\Folder\\00_Summary.md', 'README.md',
    '/abs/notes.md', '~/notes.md', 'C:\\Users\\me\\notes.md', 'c:/Users/me/Folder/', 'file:///tmp/notes.md', 'Some%20Folder/a.md#intro']) {
    expect(chatLinkPath(href)).toBe(href);
  }
  for (const href of ['', '   ', '#section', '?q=1', 'https://example.test/a', 'mailto:a@b.test', 'javascript:alert(1)', 'data:text/html,x',
    'vscode://file/x', '//host/share/a', '\\\\host\\share\\a', 'a\nb']) {
    expect(chatLinkPath(href)).toBeNull();
  }
});
