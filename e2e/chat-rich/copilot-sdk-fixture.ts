import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFixture, serializeFixture } from '../../scripts/chat-fixtures/fixture-format.mjs';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';

/** Override every provider/model input read by the SDK driver. An empty base
 * URL disables provider mapping; synthetic fixture auth supplies the login.
 * Applied in the app's launch environment. This is a narrow fixture override,
 * not an allowlist of the app's environment. */
export const SDK_FIXTURE_ENV: Record<string, string> = {
  COPILOT_MODEL: 'fake-model',
  COPILOT_PROVIDER_BASE_URL: '',
  COPILOT_PROVIDER_TYPE: '',
  COPILOT_PROVIDER_WIRE_API: '',
  COPILOT_PROVIDER_TRANSPORT: '',
  COPILOT_PROVIDER_HEADERS: '',
  COPILOT_PROVIDER_API_KEY: '',
  COPILOT_PROVIDER_API_KEY_COMMAND: '',
  COPILOT_PROVIDER_BEARER_TOKEN: '',
  COPILOT_PROVIDER_AZURE_API_VERSION: '',
  COPILOT_PROVIDER_MODEL_ID: '',
  COPILOT_PROVIDER_WIRE_MODEL: '',
  COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '',
  COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '',
};

/**
 * Write `source` (a committed copilot-sdk fixture's name, or the path of one
 * chat-script.ts built) to `dir` with only the fake login response changed:
 * the recordings are logged out. A recording's closing session.detach and
 * what follows it are dropped, so the fixture is complete once the test's
 * turns are; the fake answers the detach on close as a standing query. No CLI,
 * login, model endpoint or recorder is invoked.
 */
export async function writeAuthenticatedSdkFixture(dir: string, source: string): Promise<string> {
  const file = path.isAbsolute(source) ? source : chatFixturePath('copilot-sdk', source);
  const parsed = parseFixture(await fs.readFile(file, 'utf8'), file);
  // The JS parser initializes its header to null; annotate the parsed object
  // here rather than changing the shared recorder/replayer for this E2E.
  const header = parsed.header as unknown as Record<string, unknown>;
  let { entries } = parsed;
  if (header.protocol !== 'copilot-sdk') throw new Error(`Expected a Copilot SDK fixture: ${file}`);
  const request = entries.find((entry) => entry.from === 'client' && entry.msg?.method === 'auth.getStatus');
  const responses = entries.filter((entry) => entry.from === 'cli' && entry.msg?.id === request?.msg.id
    && entry.msg?.result?.isAuthenticated === false);
  if (!request || responses.length !== 1) throw new Error('Expected one recorded logged-out auth response');
  responses[0].msg.result = { ...responses[0].msg.result, isAuthenticated: true, statusMessage: 'Synthetic fake-only E2E authentication' };
  const detach = entries.findIndex((entry) => entry.from === 'client' && entry.msg?.method === 'session.detach');
  if (detach >= 0) entries = entries.slice(0, detach);
  const derivedFrom = path.isAbsolute(source) ? 'a script built by chat-script.ts' : `test/chat-fixtures/copilot-sdk/${source}.jsonl`;
  header.source = 'hand-made';
  header.derivedFrom = derivedFrom;
  header.synthesized = [
    ...((header.synthesized as string[] | undefined) ?? []),
    'auth.getStatus result: authenticated, for fake-only app E2E; not real-login evidence',
  ];
  // session.create has no explicit payload `match` in the recording. The
  // shared strict matcher compares its method only, not the recorded BYOK
  // provider object. Replay is not provider-payload or authentication parity.
  delete header.recordedAt;
  const fixture = path.join(dir, `sdk-${path.basename(file, '.jsonl')}-authenticated.jsonl`);
  await fs.writeFile(fixture, serializeFixture(header, entries));
  return fixture;
}
