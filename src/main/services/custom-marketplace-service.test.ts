import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
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
    it('returns empty array when file does not exist', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);
      expect(await listCustomMarketplaces()).toEqual([]);
    });

    it('returns parsed marketplace list', async () => {
      const data = [
        { id: 'cm-1', name: 'My Store', url: 'https://example.com/registry.json', enabled: true },
      ];
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(data));

      const result = await listCustomMarketplaces();
      expect(result).toEqual(data);
    });

    it('returns empty array on parse error', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue('not json');

      expect(await listCustomMarketplaces()).toEqual([]);
    });
  });

  describe('addCustomMarketplace', () => {
    it('adds a marketplace and persists it', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const result = await addCustomMarketplace({
        name: 'My Store',
        url: 'https://example.com/registry.json',
      });

      expect(result.name).toBe('My Store');
      expect(result.url).toBe('https://example.com/registry.json');
      expect(result.enabled).toBe(true);
      expect(result.id).toMatch(/^custom-/);

      expect(fsp.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('custom-marketplaces.json'),
        expect.stringContaining('My Store'),
        'utf-8',
      );
    });

    it('auto-appends registry.json when URL does not end with .json', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const result = await addCustomMarketplace({
        name: 'My Store',
        url: 'https://example.com/my-registry/',
      });

      expect(result.url).toBe('https://example.com/my-registry/registry.json');
    });

    it('throws on duplicate URL', async () => {
      const existing = [
        { id: 'cm-1', name: 'Existing', url: 'https://example.com/registry.json', enabled: true },
      ];
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(existing));

      await expect(
        addCustomMarketplace({
          name: 'New Name',
          url: 'https://example.com/registry.json',
        }),
      ).rejects.toThrow('already exists');
    });
  });

  describe('removeCustomMarketplace', () => {
    it('removes marketplace by id', async () => {
      const data = [
        { id: 'cm-1', name: 'Store A', url: 'https://a.com/registry.json', enabled: true },
        { id: 'cm-2', name: 'Store B', url: 'https://b.com/registry.json', enabled: true },
      ];
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(data));
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      await removeCustomMarketplace({ id: 'cm-1' });

      expect(fsp.writeFile).toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written).toHaveLength(1);
      expect(written[0].id).toBe('cm-2');
    });

    it('throws when marketplace not found', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue('[]');

      await expect(removeCustomMarketplace({ id: 'nonexistent' })).rejects.toThrow('not found');
    });
  });

  describe('toggleCustomMarketplace', () => {
    it('toggles enabled state', async () => {
      const data = [
        { id: 'cm-1', name: 'Store', url: 'https://a.com/registry.json', enabled: true },
      ];
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(data));
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const result = await toggleCustomMarketplace({ id: 'cm-1', enabled: false });
      expect(result.enabled).toBe(false);

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written[0].enabled).toBe(false);
    });

    it('throws when marketplace not found', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue('[]');

      await expect(toggleCustomMarketplace({ id: 'nonexistent', enabled: true })).rejects.toThrow('not found');
    });
  });
});
