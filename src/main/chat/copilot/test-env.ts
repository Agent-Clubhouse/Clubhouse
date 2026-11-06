/** Test-only environment for the fake executable. No caller credentials, proxy,
 * provider settings, or home directories are inherited by the child. */
export function fakeCopilotEnv(parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, COPILOT_HOME: home,
    XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, TMPDIR: home, TMP: home, TEMP: home,
  };
  // cmd.exe and native Windows libraries need these; the fake shim invokes
  // Node by absolute path, so no inherited PATH is needed on any platform.
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT']) {
    if (parent[key]) env[key] = parent[key];
  }
  return env;
}
