import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFixture, serializeFixture } from '../../scripts/chat-fixtures/fixture-format.mjs';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';

/** Override every provider/model input read by the SDK driver. An empty base
 * URL disables provider mapping; synthetic fixture auth supplies the login.
 * Applied at launch AND through a project profile, after login-shell env. This
 * is a narrow fixture override, not an allowlist of the app's environment. */
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

/** Derive only the fake login response. The committed recording remains logged
 * out and unchanged; no CLI, login, model endpoint or recorder is invoked. */
export async function writeAuthenticatedSdkFixture(dir: string): Promise<string> {
  const source = chatFixturePath('copilot-sdk', 'multi-turn');
  const parsed = parseFixture(await fs.readFile(source, 'utf8'), source);
  // The JS parser initializes its header to null; annotate the parsed object
  // here rather than changing the shared recorder/replayer for this E2E.
  const header = parsed.header as unknown as Record<string, unknown>;
  const { entries } = parsed;
  if (header.protocol !== 'copilot-sdk') throw new Error('Expected the SDK multi-turn recording');
  const request = entries.find((entry) => entry.from === 'client' && entry.msg?.method === 'auth.getStatus');
  const responses = entries.filter((entry) => entry.from === 'cli' && entry.msg?.id === request?.msg.id
    && entry.msg?.result?.isAuthenticated === false);
  if (!request || responses.length !== 1) throw new Error('Expected one recorded logged-out auth response');
  responses[0].msg.result = { ...responses[0].msg.result, isAuthenticated: true, statusMessage: 'Synthetic fake-only E2E authentication' };
  header.source = 'hand-made';
  header.derivedFrom = 'test/chat-fixtures/copilot-sdk/multi-turn.jsonl';
  header.synthesized = ['auth.getStatus result: authenticated, for fake-only app E2E; not real-login evidence'];
  // session.create has no explicit payload `match` in the recording. The
  // shared strict matcher compares its method only, not the recorded BYOK
  // provider object. Replay is not provider-payload or authentication parity.
  delete header.recordedAt;
  const fixture = path.join(dir, 'sdk-multi-turn-authenticated.jsonl');
  await fs.writeFile(fixture, serializeFixture(header, entries));
  return fixture;
}
