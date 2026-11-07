import { absoluteViewPath, isFileScopeDenied, openLocalFileLink } from './file-preview';
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
