import { describe, it, expect } from 'vitest';

// We test the exported component via the module exports in main.test.ts.
// Here we test the internal helper logic by importing the module and verifying
// the component is a valid function (deeper component tests require DOM/React rendering).

import { FileTree } from './FileTree';

describe('FileTree', () => {
  it('is a function component', () => {
    expect(typeof FileTree).toBe('function');
  });

  it('has the correct function name', () => {
    expect(FileTree.name).toBe('FileTree');
  });
});
