import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { copilotSessionStateDir } from './copilot-session-state';

describe('copilotSessionStateDir', () => {
  it('is $COPILOT_HOME/session-state, defaulting to ~/.copilot', () => {
    const home = path.join(os.tmpdir(), 'copilot-home');
    expect(copilotSessionStateDir({ COPILOT_HOME: home })).toBe(path.join(home, 'session-state'));
    expect(copilotSessionStateDir({})).toBe(path.join(os.homedir(), '.copilot', 'session-state'));
  });

  it('expands ~ and ignores a blank COPILOT_HOME, like the terminal path (#2296)', () => {
    expect(copilotSessionStateDir({ COPILOT_HOME: '~/alt-copilot' })).toBe(path.join(os.homedir(), 'alt-copilot', 'session-state'));
    expect(copilotSessionStateDir({ COPILOT_HOME: ' ~ ' })).toBe(path.join(os.homedir(), 'session-state'));
    expect(copilotSessionStateDir({ COPILOT_HOME: '  ' })).toBe(path.join(os.homedir(), '.copilot', 'session-state'));
    const home = path.join(os.tmpdir(), 'copilot-config');
    expect(copilotSessionStateDir({ COPILOT_HOME: '', GH_COPILOT_CONFIG_DIR: home })).toBe(path.join(home, 'session-state'));
  });
});
