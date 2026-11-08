import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { ActionError } from '../../../shared/actions';
import { matchProjectRef } from './project-ref';

const root = path.resolve('projects');
const web = { id: 'p1', name: 'web', path: path.join(root, 'web') };
const api = { id: 'p2', name: 'api', displayName: 'API server', path: path.join(root, 'api') };
const web2 = { id: 'p3', name: 'web', path: path.join(root, 'other', 'web') };
const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);

describe('matchProjectRef', () => {
  it('matches by id, name, display name and path', () => {
    expect(matchProjectRef([web, api], 'p2', same)).toBe('p2');
    expect(matchProjectRef([web, api], 'WEB', same)).toBe('p1');
    expect(matchProjectRef([web, api], 'api server', same)).toBe('p2');
    expect(matchProjectRef([web, api], path.join(root, 'api'), same)).toBe('p2');
    expect(matchProjectRef([web, api], 'nowhere', same)).toBeUndefined();
  });

  it('refuses a name two projects share, and takes either by path', () => {
    expect(() => matchProjectRef([web, web2], 'web', same)).toThrow(ActionError);
    try {
      matchProjectRef([web, web2], 'web', same);
    } catch (err) {
      expect((err as ActionError).code).toBe('invalid_input');
    }
    expect(matchProjectRef([web, web2], web2.path, same)).toBe('p3');
  });
});
