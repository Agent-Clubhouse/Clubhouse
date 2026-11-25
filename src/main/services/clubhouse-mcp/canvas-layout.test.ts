import { describe, it, expect } from 'vitest';
import { snapToGrid } from './canvas-layout';

describe('canvas-layout', () => {
  describe('snapToGrid', () => {
    it('snaps to nearest 20px grid', () => {
      expect(snapToGrid(0)).toBe(0);
      expect(snapToGrid(10)).toBe(20);
      expect(snapToGrid(19)).toBe(20);
      expect(snapToGrid(20)).toBe(20);
      expect(snapToGrid(30)).toBe(40);
      expect(snapToGrid(105)).toBe(100);
    });
  });
});
