import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import {
  listCustomMarketplaces,
  addCustomMarketplace,
  removeCustomMarketplace,
  toggleCustomMarketplace,
} from './custom-marketplace-service';

describe('custom-marketplace-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listCustomMarketplaces', () => {
    it('returns empty array when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(listCustomMarketplaces()).toEqual([]);
    });

    it('returns parsed marketplace list', () => {
      const data = [
        { id: 'cm-1', name: 'My Store', url: 'https://example.com/registry.json', enabled: true },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));

      const result = listCustomMarketplaces();
      expect(result).toEqual(data);
    });

    it('returns empty array on parse error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not json');

      expect(listCustomMarketplaces()).toEqual([]);
    });
  });

  describe('addCustomMarketplace', () => {
    it('adds a marketplace and persists it', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = addCustomMarketplace({
        name: 'My Store',
        url: 'https://example.com/registry.json',
      });

      expect(result.name).toBe('My Store');
      expect(result.url).toBe('https://example.com/registry.json');
      expect(result.enabled).toBe(true);
      expect(result.id).toMatch(/^custom-/);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('custom-marketplaces.json'),
        expect.stringContaining('My Store'),
        'utf-8',
      );
    });

    it('auto-appends registry.json when URL does not end with .json', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = addCustomMarketplace({
        name: 'My Store',
        url: 'https://example.com/my-registry/',
      });

      expect(result.url).toBe('https://example.com/my-registry/registry.json');
    });

    it('throws on duplicate URL', () => {
      const existing = [
        { id: 'cm-1', name: 'Existing', url: 'https://example.com/registry.json', enabled: true },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing));

      expect(() =>
        addCustomMarketplace({
          name: 'New Name',
          url: 'https://example.com/registry.json',
        }),
      ).toThrow('already exists');
    });
  });

  describe('removeCustomMarketplace', () => {
    it('removes marketplace by id', () => {
      const data = [
        { id: 'cm-1', name: 'Store A', url: 'https://a.com/registry.json', enabled: true },
        { id: 'cm-2', name: 'Store B', url: 'https://b.com/registry.json', enabled: true },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));

      removeCustomMarketplace({ id: 'cm-1' });

      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written).toHaveLength(1);
      expect(written[0].id).toBe('cm-2');
    });

    it('throws when marketplace not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('[]');

      expect(() => removeCustomMarketplace({ id: 'nonexistent' })).toThrow('not found');
    });
  });

  describe('toggleCustomMarketplace', () => {
    it('toggles enabled state', () => {
      const data = [
        { id: 'cm-1', name: 'Store', url: 'https://a.com/registry.json', enabled: true },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));

      const result = toggleCustomMarketplace({ id: 'cm-1', enabled: false });
      expect(result.enabled).toBe(false);

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written[0].enabled).toBe(false);
    });

    it('throws when marketplace not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('[]');

      expect(() => toggleCustomMarketplace({ id: 'nonexistent', enabled: true })).toThrow('not found');
    });
  });
});
