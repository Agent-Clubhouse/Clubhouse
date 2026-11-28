// Replay the exact mobile chat handler from each release. Dependencies simulate a
// paired phone, a selected live chat, and a transcript read held at a known await.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const ts = require('typescript');

function readHandler(commit) {
  const text = execFileSync('git', ['show', commit + ':src/main/services/annex-server.ts'], {encoding: 'utf8'});
  const tree = ts.createSourceFile('server.ts', text, ts.ScriptTarget.Latest, true);
  const handler = tree.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'handleMobileChatRoute');
  assert(handler);
  return ts.transpileModule(handler.getText(tree), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
}
function latch() {
  let signal;
  const done = new Promise(resolve => { signal = resolve; });
  return {done, signal};
}
async function exercise(code, transition) {
  const agentId = 'fixture-dispatcher', entered = latch(), release = latch();
  let run = 'fixture-run-1', pageCalls = 0, status, body;
  const runtime = {
    kind: 'chat', isRunning: () => true, getState: () => 'idle',
    getSessionId: () => 'fixture-session', getNativeSessionId: () => 'fixture-native',
    getDisplayRunId: () => run,
    async readTranscript() {
      entered.signal();
      await release.done;
      return {events: [{seq: 1, sessionId: 'fixture-session', data: {text: 'On it.'}}]};
    },
  };
  const registration = {nonce: 'fixture-read'};
  const handle = vm.runInNewContext(code + '\nhandleMobileChatRoute;', {
    URL, Buffer, mobileCommands: {epoch: 'fixture'}, agentRegistry: {get: () => registration},
    findMobileAgent: async () => ({config: {id: agentId}}), trackedQuickAgents: new Set(),
    getAgentRuntime: () => runtime, desktopDetailsAuthorized: () => false, isDisposedAgent: () => false,
    authorizerDeps: {}, stillAuthorized: () => true,
    phoneChatEvents: (_id, events) => events, isAgentRunning: () => true,
    RICH_CHAT_CONTENT_FLAG: 'fixture', isGraduatedFeatureOn: () => false,
    pendingInteractions: () => ({pendingQuestions: [], pendingPermissions: []}),
    latestSlashCommands: () => [], chatControls: () => null,
    buildChatPage({eligible, metadata}) {
      pageCalls++;
      return {stage: 'whole', ok: true, body: JSON.stringify({...metadata,events: eligible})};
    },
    sendJson(_res, code, value) { status = code; body = value; },
  });
  const ctx = {url: '/api/v1/mobile/agents/' + agentId + '/chat', principal: {}, res: {
    writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); },
  }};
  const pending = handle(ctx, ['', agentId]);
  await Promise.race([entered.done, pending.then(() => assert.fail('Handler exited before transcript acquisition'))]);
  if (transition) run = 'fixture-run-2';
  release.signal();
  await pending;
  return {status, pageCalls, visible: body?.events?.[0]?.data?.text, error: body?.error};
}
(async () => {
  for (const [release, commit] of Object.entries({
    beta7: 'dc8e82236eb2ae8dadb6bd309297d0c157caaba4',
    beta8: '30fd3ab0fdca6dbe75aed0b91e4c9878eded9b71',
  })) {
    const handler = readHandler(commit);
    for (const transition of [false, true]) {
      const result = await exercise(handler, transition);
      const changed = release === 'beta8' && transition;
      assert.deepEqual(result, {status: changed ? 409 : 200, pageCalls: changed ? 0 : 1,
        visible: changed ? undefined : 'On it.', error: changed ? 'chat_read_changed' : undefined});
      console.log(JSON.stringify({release, transition, ...result}));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
