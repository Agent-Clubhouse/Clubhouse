// PILOT, never ships. One scenario for two drivers: a Playwright page in Electron on CI
// (feedback-editor-pilot.spec.ts) and raw CDP in headless Chromium locally (scripts/pilot/run-chromium.mjs).
// It records what happened. `problems` is what contradicts the contract or this pilot's expectations.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runScenario(page, fixture, options = {}) {
  const report = { problems: [] };
  try {
    await steps(page, fixture, options, report);
  } catch (error) {
    report.problems.push(`aborted: ${error.message}`);
    report.aborted = true;
    try {
      report.abortedAt = await page.evaluate(() => ({ active: window.__feedbackEditorPilot.deepActive(), body: document.body.innerText.slice(0, 600), violations: window.__feedbackEditorPilot.violations }));
    } catch { /* The page itself may have gone. */ }
  }
  return report;
}

async function steps(page, fixture, { perf = false }, report) {
  const expectThat = (name, ok, detail) => { if (!ok) report.problems.push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`); };
  const call = (name, ...args) => page.evaluate(([method, values]) => window.__feedbackEditorPilot[method](...values), [name, args]);
  const rect = async (selector) => call('deepRect', selector);
  const until = async (fn, what, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await wait(50);
    }
  };
  const click = async (selector) => {
    const box = await until(() => rect(selector), selector);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
  };
  const dragIn = async (selector, from, to) => {
    const box = await until(() => rect(selector), selector);
    const at = ([fx, fy]) => [box.x + box.width * fx, box.y + box.height * fy];
    const [ax, ay] = at(from);
    const [bx, by] = at(to);
    await page.mouse.move(ax, ay);
    await page.mouse.down();
    await page.mouse.move((ax + bx) / 2, (ay + by) / 2);
    await page.mouse.move(bx, by);
    await page.mouse.up();
    await wait(60);
  };
  const text = (selector) => page.evaluate((s) => {
    const host = document.querySelector('[data-feedback-capture="exclude"]');
    const el = (host?.shadowRoot ?? document).querySelector(s) ?? document.querySelector(s);
    return el ? el.textContent : null;
  }, selector);
  const exists = async (selector) => (await rect(selector)) !== null;
  const lastSend = async () => page.evaluate(() => { const all = window.__feedbackEditorPilot.sends; const s = all[all.length - 1]; return s ? { input: s.input, bytes: s.bytes, sha: s.sha } : null; });

  report.env = await call('env');
  report.supported = await call('supported');

  // ---- contract section 3 ----
  report.vectors = [];
  for (const { id } of fixture.vectors) {
    const result = await call('runVector', fixture, id);
    report.vectors.push(result);
    expectThat(`vector ${id}`, result.failures.length === 0, result.failures);
  }

  // ---- CSP ----
  report.csp = await call('probeCsp');
  expectThat('createImageBitmap under the production CSP', report.csp.createImageBitmapFromBlob);
  expectThat('constructable stylesheet under the production CSP', report.csp.constructableSheet);
  report.worker = await call('probeWorker');
  report.revertCases = await call('revertCases');
  for (const row of report.revertCases.rows) {
    if (/^(after failed|carried)/.test(row.name)) {
      expectThat(`${row.name}: no original pixel in the bytes`, JSON.stringify(row.covered) === '[0,0,0]', row);
      expectThat(`${row.name}: no original pixel in the preview`, JSON.stringify(row.preview) === '[0,0,0]', row);
      expectThat(`${row.name}: edits stay final`, row.editsAreFinal === true && row.original === false, row);
    }
  }
  report.concurrentCases = await call('concurrentCases');
  expectThat('a second call in flight is refused in-progress', report.concurrentCases.secondCode === 'in-progress' && report.concurrentCases.first === true, report.concurrentCases);
  report.beginSendCases = await call('beginSendCases');
  for (const row of report.beginSendCases.rows) {
    if (row.edited) expectThat(`${row.name}: no original pixel under the redaction`, JSON.stringify(row.coveredPixel) === '[0,0,0]', row);
    if (row.edited) expectThat(`${row.name}: never the source`, row.finalIsSource === false, row);
    expectThat(`${row.name}: a retry is the same and tells no one`, row.retry.sameBytes && row.retry.sameFinal && row.retry.sameFlags && row.retry.notified === 0 && row.retry.sameSnapshot, row);
  }
  expectThat('dispose during beginSend resolves disposed', report.beginSendCases.dispose.settled === 'resolved' && report.beginSendCases.dispose.code === 'disposed', report.beginSendCases.dispose);
  const violationsBeforeUi = await page.evaluate(() => window.__feedbackEditorPilot.violations.length);

  // ---- own React UI, two windows ----
  const W = 1600, H = 1000;
  const shots = await call('open', [{ width: W, height: H, label: 'Main window' }, { width: 800, height: 600, label: 'Pop-out' }]);
  report.shots = shots;
  await until(() => exists('[data-testid="feedback-preview"]'), 'the composer');
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the composer preview');

  // Pen and Redact through real input, in the React editor.
  await click('[data-testid="pilot-edit-react"]');
  await until(() => exists('[data-testid="pilot-stage"]'), 'the React editor');
  await wait(300);
  report.reactFocus = await call('deepActive');
  await click('[data-testid="pilot-tool-pen"]');
  await click('[data-testid="pilot-ink-yellow"]');
  await dragIn('[data-testid="pilot-stage"]', [0.3, 0.3], [0.5, 0.3]);
  await click('[data-testid="pilot-tool-redact"]');
  await dragIn('[data-testid="pilot-stage"]', [0.05, 0.05], [0.2, 0.2]);
  report.reactMarks = await text('[data-testid="pilot-stage"]') === null ? null : await page.evaluate(() => document.querySelector('[data-testid="pilot-stage"]').getAttribute('aria-label'));
  expectThat('two marks from real input', /2 marks/.test(report.reactMarks ?? ''), report.reactMarks);

  // Undo takes the redaction back. Redo it, then a tap makes no mark.
  await click('[data-testid="pilot-undo"]');
  await wait(50);
  expectThat('undo', /1 mark\b/.test(await page.evaluate(() => document.querySelector('[data-testid="pilot-stage"]').getAttribute('aria-label'))));
  await dragIn('[data-testid="pilot-stage"]', [0.05, 0.05], [0.2, 0.2]);
  await dragIn('[data-testid="pilot-stage"]', [0.7, 0.7], [0.7, 0.7]);
  expectThat('a tap is no redaction', /2 marks/.test(await page.evaluate(() => document.querySelector('[data-testid="pilot-stage"]').getAttribute('aria-label'))));

  // Zoom with the wheel-free buttons, and a pan, then fit. A failure here would throw on the camera.
  await click('[data-testid="pilot-tool-move"]');
  await click('[data-testid="pilot-zoom-in"]');
  await dragIn('[data-testid="pilot-stage"]', [0.5, 0.5], [0.4, 0.4]);
  await click('[data-testid="pilot-zoom-fit"]');

  // Clear's words before a Send, then Cancel the confirmation.
  await click('[data-testid="pilot-clear"]');
  await until(() => exists('[data-testid="pilot-clear-text"]'), 'the Clear confirmation');
  report.reactClearBefore = await text('[data-testid="pilot-clear-text"]');
  expectThat('Clear before a Send says the original comes back', /original image comes back/.test(report.reactClearBefore ?? ''), report.reactClearBefore);
  await page.keyboard.press('Escape');
  await wait(100);
  expectThat('Esc closes only the confirmation', await exists('[data-testid="pilot-stage"]'));

  // Done flattens, and the composer shows it.
  await click('[data-testid="pilot-done"]');
  await until(async () => !(await exists('[data-testid="pilot-stage"]')), 'Done to close the editor', 30000);
  report.afterDone = await text('[data-testid="pilot-state"]');
  expectThat('the composer says edited', /You edited this image/.test(report.afterDone ?? ''), report.afterDone);

  // A second visit, Cancel: nothing changes.
  await click('[data-testid="pilot-edit-react"]');
  await until(() => exists('[data-testid="pilot-stage"]'), 'the React editor again');
  await wait(300);
  await click('[data-testid="pilot-tool-pen"]');
  await dragIn('[data-testid="pilot-stage"]', [0.3, 0.6], [0.5, 0.6]);
  expectThat('third mark in the visit', /3 marks/.test(await page.evaluate(() => document.querySelector('[data-testid="pilot-stage"]').getAttribute('aria-label'))));
  await click('[data-testid="pilot-cancel"]');
  await until(async () => !(await exists('[data-testid="pilot-stage"]')), 'Cancel to close the editor');

  // Include off and on, the other window's thumbnail, then back.
  await click('[data-testid="feedback-include"]');
  await wait(50);
  report.leftOut = await text('[data-testid="pilot-state"]');
  expectThat('left out says so', /won't be sent/.test(report.leftOut ?? ''), report.leftOut);
  await click('[data-testid="feedback-include"]');
  await click('[data-testid="feedback-shot-1"]');
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width === 400), 'the second window preview');
  await click('[data-testid="feedback-shot-0"]');
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 450), 'the first window preview');

  // The warning: s0 has marks from the visits above. It's for the view not selected, so it follows the picker.
  const warning = () => text('[data-testid="pilot-other-views"]');
  report.otherViews = { onMarkedWindow: await warning() };
  await click('[data-testid="feedback-shot-1"]');
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width === 400), 'the second window for the warning');
  report.otherViews.afterSwitch = await warning();
  expectThat('the warning appears after a picker switch', /won't be sent/.test(report.otherViews.afterSwitch ?? ''), report.otherViews);
  await click('[data-testid="feedback-include"]');
  await wait(50);
  report.otherViews.leftOut = await warning();
  await click('[data-testid="feedback-include"]');
  await wait(50);
  await click('[data-testid="feedback-shot-0"]');
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 450), 'the first window for the warning');
  report.otherViews.afterSwitchBack = await warning();
  expectThat('the warning clears on switching back', report.otherViews.afterSwitchBack === null, report.otherViews);

  // First Send fails: the view locks, Clear changes its words, the same bytes retry.
  report.storeBeforeSend = await call('storeHoldsImages');
  await call('failNextSend', 'storage full');
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-error"]'), 'the failed Send', 30000);
  const first = await lastSend();
  const sendsBeforeRetry = await call('sendCount');
  report.firstSend = first;
  expectThat('first Send carries bytes of the first window', first?.bytes > 0 && first?.input.shotId === 's0' && first?.input.includeScreenshot === true, first);
  expectThat('edited bytes differ from the capture', first?.sha !== shots[0].sha, { sent: first?.sha, capture: shots[0].sha });
  report.storeAfterSend = await call('storeHoldsImages');
  expectThat('the store drops the windows after the first Send', report.storeAfterSend === false);
  expectThat('the picker has gone after the first Send', !(await exists('[data-testid="feedback-shots"]')));
  report.otherViews.afterFirstSend = await warning();
  expectThat('the warning has gone after the first Send', report.otherViews.afterFirstSend === null, report.otherViews);
  report.afterFailedSend = await text('[data-testid="pilot-state"]');
  expectThat('after a failed Send the note says final', /can't be undone/.test(report.afterFailedSend ?? ''), report.afterFailedSend);

  // The pixels that would reach main, read from the PNG itself.
  const px = (fx, fy) => [Math.floor(W * fx), Math.floor(H * fy)];
  report.sentPixels = await call('sentPixels', -1, [px(0.12, 0.12), px(0.02, 0.5)]);
  expectThat('the redaction is black in the bytes', JSON.stringify(report.sentPixels?.pixels?.[0]) === '[0,0,0]', report.sentPixels);
  expectThat('only IHDR, IDAT, IEND', JSON.stringify(report.sentPixels?.chunks) === '["IHDR","IDAT","IEND"]', report.sentPixels?.chunks);

  // Clear after the failed Send: new marks only, and the words say so.
  await click('[data-testid="pilot-edit-react"]');
  await until(() => exists('[data-testid="pilot-stage"]'), 'the editor after a failed Send');
  await wait(200);
  await click('[data-testid="pilot-tool-pen"]');
  await dragIn('[data-testid="pilot-stage"]', [0.3, 0.8], [0.5, 0.8]);
  await click('[data-testid="pilot-clear"]');
  await until(() => exists('[data-testid="pilot-clear-text"]'), 'Clear after a failed Send');
  report.reactClearAfter = await text('[data-testid="pilot-clear-text"]');
  expectThat('Clear after a failed Send says covered stays covered', /stays covered/.test(report.reactClearAfter ?? ''), report.reactClearAfter);
  await click('[data-testid="pilot-clear-yes"]');
  await wait(50);
  await click('[data-testid="pilot-cancel"]');
  await until(async () => !(await exists('[data-testid="pilot-stage"]')), 'Cancel after Clear');

  // Retry after a second save failure: the same bytes under Begin-Send.
  await call('failNextSend', 'storage full');
  await click('[data-testid="feedback-send"]');
  await until(async () => (await lastSend())?.sha === first?.sha && (await call('sendCount')) === sendsBeforeRetry + 1, 'the retried Send', 30000);
  report.retriedSend = await lastSend();
  expectThat('a retry carries the same bytes', report.retriedSend?.sha === first?.sha, { first: first?.sha, retry: report.retriedSend?.sha });
  await until(() => exists('[data-testid="feedback-error"]'), 'the retried Send error', 30000);

  // Then the reopen a moved enrollment causes.
  await call('reopenOnNextSend');
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-reopened"]'), 'the reopened draft', 30000);
  await until(() => exists('[data-testid="feedback-preview"]'), 'the reopened composer');
  report.reopenedState = await text('[data-testid="pilot-state"]');
  // The carried image is final from creation: the Clear words are right before any new Send, in both editors.
  await click('[data-testid="pilot-edit-react"]');
  await until(() => exists('[data-testid="pilot-stage"]'), 'the React editor on the carried image');
  await wait(300);
  await click('[data-testid="pilot-tool-pen"]');
  await dragIn('[data-testid="pilot-stage"]', [0.3, 0.8], [0.5, 0.8]);
  await click('[data-testid="pilot-clear"]');
  await until(() => exists('[data-testid="pilot-clear-text"]'), 'Clear on the carried image');
  report.carriedClearReact = await text('[data-testid="pilot-clear-text"]');
  expectThat('carried: Clear says covered stays covered', /stays covered/.test(report.carriedClearReact ?? ''), report.carriedClearReact);
  await click('[data-testid="pilot-clear-yes"]');
  await wait(50);
  await click('[data-testid="pilot-cancel"]');
  await until(async () => !(await exists('[data-testid="pilot-stage"]')), 'Cancel on the carried image');
  await click('[data-testid="pilot-edit-mounted"]');
  await until(async () => (await call('mountedState')).open, 'the mounted view on the carried image');
  await wait(300);
  await click('[data-tool="pen"]');
  await dragIn('canvas', [0.3, 0.8], [0.5, 0.8]);
  await click('[data-action="clear"]');
  await wait(100);
  report.carriedClearMounted = (await call('mountedState')).confirmText;
  expectThat('carried, mounted: Clear says covered stays covered', /stays covered/.test(report.carriedClearMounted ?? ''), report.carriedClearMounted);
  await page.keyboard.press('Escape');
  await wait(100);
  await click('[data-action="cancel"]');
  await until(async () => !(await call('mountedState')).mounted, 'Cancel in the mounted view on the carried image');
  // Bytes still go on every included Send.
  // A reopened draft brings its bytes on every included Send.
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-sent-state"]'), 'the Send after a reopen', 30000);
  report.reopenedSend = await lastSend();
  expectThat('a reopened Send brings the carried bytes', report.reopenedSend?.sha === first?.sha && report.reopenedSend?.input.shotId === 's0', { first: first?.sha, reopened: report.reopenedSend });
  await call('close');
  await wait(100);

  // ---- mounted view inside the app's Modal ----
  await call('open', [{ width: 1200, height: 800, label: 'Main window' }, { width: 800, height: 600, label: 'Pop-out' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the composer for the mounted view');
  await click('[data-testid="pilot-edit-mounted"]');
  await until(async () => (await call('mountedState')).open, 'the mounted view');
  await wait(300);
  report.mounted = await call('mountedState');
  expectThat('the mounted view is a real modal', report.mounted.modal);
  expectThat('constructable stylesheet adopted', report.mounted.sheets === 1, report.mounted.sheets);
  report.mountedThemeApplied = /^rgb\(30, 30, 46\)$/.test(report.mounted.background ?? '');
  expectThat('theme custom properties reach the shadow root', report.mountedThemeApplied, report.mounted.background);

  await call('watchKeys');
  // Focus: in on open, Tab stays inside the shadow root however far it goes.
  report.mountedFocus = await call('deepActive');
  expectThat('focus moves inside the shadow root', report.mountedFocus.some((p) => p.startsWith('canvas')), report.mountedFocus);
  const tabs = [];
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); tabs.push((await call('deepActive')).at(-1)); }
  report.mountedTabs = tabs;
  expectThat('Tab never leaves the view', tabs.every((t) => /^(button|canvas)/.test(t)), tabs);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Tab');
  expectThat('Shift+Tab stays in the view', /^(button|canvas)/.test((await call('deepActive')).at(-1)));

  report.mountedKeysHeard = await call('heardKeys');
  expectThat('keys do not bubble out of the view', report.mountedKeysHeard.documentBubble === 0 && report.mountedKeysHeard.windowBubble === 0, report.mountedKeysHeard);
  // Marks with real input, through the shadow root.
  await click('[data-tool="pen"]');
  await click('[data-ink="blue"]');
  await dragIn('canvas', [0.3, 0.3], [0.5, 0.3]);
  await click('[data-tool="redact"]');
  await dragIn('canvas', [0.1, 0.1], [0.2, 0.2]);
  report.mountedCanvasLabel = await page.evaluate(() => document.querySelector('[data-feedback-capture="exclude"]').shadowRoot.querySelector('canvas').getAttribute('aria-label'));
  expectThat('two marks in the mounted view', /2 marks/.test(report.mountedCanvasLabel ?? ''), report.mountedCanvasLabel);

  // Clear's confirmation, then Esc closes only that.
  await click('[data-action="clear"]');
  await wait(100);
  report.mountedConfirm = (await call('mountedState')).confirmText;
  await page.keyboard.press('Escape');
  await wait(100);
  expectThat('Esc on the confirmation leaves the view open', (await call('mountedState')).open);
  await click('[data-action="undo"]');
  await wait(50);

  // Esc cancels this visit only: the app's Modal stays, with its note, and focus comes back.
  await page.keyboard.press('Escape');
  await until(async () => !(await call('mountedState')).mounted, 'Esc to close the mounted view');
  await wait(100);
  expectThat('Esc in the view does not close the composer', await exists('[data-testid="feedback-review"]'));
  report.mountedFocusAfter = await call('deepActive');
  expectThat('focus returns to the composer', report.mountedFocusAfter.some((p) => /pilot-edit-mounted/.test(p)), report.mountedFocusAfter);

  // Done in the mounted view, then Send, and read the bytes.
  await click('[data-testid="pilot-edit-mounted"]');
  await until(async () => (await call('mountedState')).open, 'the mounted view again');
  await wait(200);
  await click('[data-tool="redact"]');
  await dragIn('canvas', [0.1, 0.1], [0.3, 0.3]);
  await click('[data-action="done"]');
  await until(async () => !(await call('mountedState')).mounted, 'Done in the mounted view', 30000);
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-sent-state"]'), 'the mounted Send', 30000);
  report.mountedSend = await lastSend();
  await call('close');

  // Unedited: the bytes are the capture's, so main can tell by hash.
  const plain = await call('open', [{ width: 1200, height: 800, label: 'Main window' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the unedited composer');
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-sent-state"]'), 'the unedited Send', 30000);
  const unedited = await lastSend();
  report.unedited = { input: unedited?.input, sent: unedited?.sha, capture: plain[0].sha };
  expectThat('unedited sends the capture\'s own bytes', unedited?.sha === plain[0].sha && unedited?.input.shotId === 's0' && unedited?.input.includeScreenshot === true, report.unedited);
  await call('close');

  // Remove: gone, and a note still sends.
  await call('open', [{ width: 800, height: 600, label: 'Main window' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the composer before Remove');
  await click('[data-testid="feedback-remove"]');
  await wait(100);
  expectThat('Remove empties the composer', !(await exists('[data-testid="feedback-preview"]')));
  report.afterRemove = await text('[data-testid="feedback-review"]');
  await page.evaluate(() => {
    const box = document.querySelector('#feedback-notes');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'a note after Remove');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(50);
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-sent-state"]'), 'Send after Remove', 30000);
  report.removedSend = await lastSend();
  expectThat('Send after Remove goes with no flag, shot or bytes', report.removedSend?.input.includeScreenshot === false && report.removedSend?.input.noEdits === undefined && report.removedSend?.input.shotId === undefined && report.removedSend?.bytes === null, report.removedSend);
  await call('close');

  // A left-out Send through the real dialog: what would reach main, never edited and edited.
  const leftOut = [];
  for (const edit of [false, true]) {
    const [{ sha: captureSha }] = await call('open', [{ width: 1000, height: 700, label: 'Main window' }]);
    await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the left-out composer');
    if (edit) {
      await click('[data-testid="pilot-edit-react"]');
      await until(() => exists('[data-testid="pilot-stage"]'), 'the editor for the left-out case');
      await wait(300);
      await click('[data-testid="pilot-tool-redact"]');
      await dragIn('[data-testid="pilot-stage"]', [0.2, 0.2], [0.4, 0.4]);
      await click('[data-testid="pilot-done"]');
      await until(async () => !(await exists('[data-testid="pilot-stage"]')), 'Done for the left-out case', 30000);
    }
    await click('[data-testid="feedback-include"]');
    await wait(50);
    await page.evaluate(() => {
      const box = document.querySelector('#feedback-notes');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'a note');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(50);
    await call('failNextSend', 'storage full');
    await click('[data-testid="feedback-send"]');
    await until(() => exists('[data-testid="feedback-error"]'), 'the failed left-out Send', 30000);
    const sent = await lastSend();
    await click('[data-testid="feedback-include"]');
    await wait(50);
    await click('[data-testid="feedback-send"]');
    await until(() => exists('[data-testid="feedback-sent-state"]'), 'the included retry', 30000);
    const retry = await lastSend();
    leftOut.push({ edit, leftOut: sent, retry });
    expectThat(`left-out Send carries shotId, edit=${edit}`, sent?.input.shotId === 's0', sent);
    expectThat(`left-out bytes, edit=${edit}`, edit ? sent?.bytes > 0 : sent?.bytes === null, sent);
    expectThat(`left-out noEdits, edit=${edit}`, sent?.input.noEdits === (edit ? undefined : true), sent);
    expectThat(`included retry after left-out, edit=${edit}`, edit ? retry?.sha === sent?.sha : retry?.sha === captureSha, { sent, retry, captureSha });
    await call('close');
    await wait(100);
  }
  report.leftOutUi = leftOut;

  // Click outside: contract section 2 says it can't silently discard a note or edits.
  await call('open', [{ width: 800, height: 600, label: 'Main window' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the composer for the backdrop');
  await page.evaluate(() => {
    const box = document.querySelector('#feedback-notes');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'a note I wrote');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(50);
  await page.mouse.move(5, 5);
  await page.mouse.down();
  await page.mouse.up();
  await wait(100);
  report.backdropClickClosedTheComposer = !(await exists('[data-testid="feedback-review"]'));
  await call('close');

  // Esc on the composer itself, with a note in it.
  await call('open', [{ width: 800, height: 600, label: 'Main window' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the composer for Esc');
  await page.evaluate(() => {
    const box = document.querySelector('#feedback-notes');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'a note I wrote');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(50);
  await page.keyboard.press('Escape');
  await wait(100);
  report.escClosedTheComposer = !(await exists('[data-testid="feedback-review"]'));
  await call('close');

  // An excluded capture that can't be prepared: a 6K window is over the pixel limit, so it has to flatten even left out.
  await call('open', [{ width: 6016, height: 3384, label: 'Main window' }, { width: 800, height: 600, label: 'Pop-out' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the 6K composer', 30000);
  await call('failFlattenOf', 6016);
  await click('[data-testid="feedback-include"]');
  await wait(50);
  await page.evaluate(() => {
    const box = document.querySelector('#feedback-notes');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'only my note');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(50);
  const sendsBeforeBlock = await call('sendCount');
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-error"]'), 'the excluded block', 30000);
  report.excludedBlock = {
    words: await text('[data-testid="feedback-error"]'),
    reachedMain: (await call('sendCount')) !== sendsBeforeBlock,
    storeKeptImages: await call('storeHoldsImages'),
    pickerStays: await exists('[data-testid="feedback-shots"]'),
    removeReachable: await exists('[data-testid="feedback-remove"]'),
  };
  expectThat('a refused Send does not reach main', !report.excludedBlock.reachedMain);
  expectThat('a refused Send ends nothing', report.excludedBlock.storeKeptImages && report.excludedBlock.pickerStays, report.excludedBlock);
  await click('[data-testid="feedback-remove"]');
  await wait(100);
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-sent-state"]'), 'the note after Remove', 30000);
  report.excludedBlock.afterRemove = await lastSend();
  expectThat('Remove gets the note out', report.excludedBlock.afterRemove?.input.includeScreenshot === false && report.excludedBlock.afterRemove?.bytes === null, report.excludedBlock.afterRemove);
  await call('clearFailures');
  await call('close');
  await wait(100);

  // The same refusal with the image included and no note: the words talk about a note that isn't there.
  await call('open', [{ width: 6016, height: 3384, label: 'Main window' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the included 6K composer', 30000);
  await call('failFlattenOf', 6016);
  await click('[data-testid="feedback-send"]');
  await until(() => exists('[data-testid="feedback-error"]'), 'the included block', 30000);
  report.includedBlock = { words: await text('[data-testid="feedback-error"]'), final: await call('storeHoldsImages') };
  await click('[data-testid="feedback-remove"]');
  await wait(100);
  report.includedBlock.sendDisabledAfterRemove = await page.evaluate(() => document.querySelector('[data-testid="feedback-send"]').disabled);
  await call('clearFailures');
  await call('close');
  await wait(100);

  // Done failing because of the window that isn't selected, in the mounted view, which is where it can happen.
  const markBoth = async () => {
    await call('open', [{ width: 1200, height: 800, label: 'Main window' }, { width: 800, height: 600, label: 'Pop-out' }]);
    await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the composer for Done');
    await click('[data-testid="pilot-edit-mounted"]');
    await until(async () => (await call('mountedState')).open, 'the mounted view for Done');
    await wait(300);
    await click('[data-view="s1"]');
    await wait(300);
    await click('[data-tool="redact"]');
    await dragIn('canvas', [0.1, 0.1], [0.3, 0.3]);
    await click('[data-view="s0"]');
    await wait(300);
    await click('[data-tool="redact"]');
    await dragIn('canvas', [0.1, 0.1], [0.3, 0.3]);
    await call('failFlattenOf', 800);
    await click('[data-action="done"]');
    await until(async () => (await text('.problem'))?.length > 0, 'Done to fail', 30000);
  };
  const canvasLabel = () => page.evaluate(() => document.querySelector('[data-feedback-capture="exclude"]').shadowRoot.querySelector('canvas').getAttribute('aria-label'));
  await markBoth();
  report.doneOnOtherWindow = {
    words: await text('.problem'),
    stillOpen: (await call('mountedState')).open,
    selected: await page.evaluate(() => document.querySelector('[data-feedback-capture="exclude"]').shadowRoot.querySelector('[data-view][aria-pressed="true"]')?.textContent),
    selectedMarks: await canvasLabel(),
  };
  // Way out one: go to the other window, Undo there, and Done keeps the good marks.
  await click('[data-view="s1"]');
  await wait(300);
  await click('[data-action="undo"]');
  await wait(50);
  await click('[data-view="s0"]');
  await wait(300);
  await click('[data-action="done"]');
  await until(async () => !(await call('mountedState')).mounted, 'Done after Undo on the other window', 30000);
  report.doneOnOtherWindow.afterUndoElsewhere = await text('[data-testid="pilot-state"]');
  expectThat('Undo on the other window lets Done through', /You edited this image/.test(report.doneOnOtherWindow.afterUndoElsewhere ?? ''), report.doneOnOtherWindow);
  await call('clearFailures');
  await call('close');
  await wait(100);
  // Way out two: Cancel, which takes the good window's marks with it.
  await markBoth();
  await click('[data-action="cancel"]');
  await until(async () => !(await call('mountedState')).mounted, 'Cancel after a failed Done');
  report.doneOnOtherWindow.afterCancel = await text('[data-testid="pilot-state"]');
  await call('clearFailures');
  await call('close');
  await wait(100);

  // Two Send clicks in one task, past the disabled button: only the host's guard can stop the second.
  await call('open', [{ width: 1000, height: 700, label: 'Main window' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the composer for a double Send');
  const sendsBeforeDouble = await call('sendCount');
  await page.evaluate(() => { const b = document.querySelector('[data-testid="feedback-send"]'); b.click(); b.click(); });
  await until(() => exists('[data-testid="feedback-sent-state"]'), 'the double Send', 30000);
  report.doubleSend = { sends: (await call('sendCount')) - sendsBeforeDouble, error: await exists('[data-testid="feedback-error"]') };
  expectThat('two clicks are one Send', report.doubleSend.sends === 1, report.doubleSend);
  await call('close');
  await wait(100);

  // The dialog closing while a Send prepares: dispose during beginSend, and nothing may reach main after.
  await call('open', [{ width: 6016, height: 3384, label: 'Main window' }]);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="feedback-preview"]')?.width > 300), 'the 6K composer for close', 30000);
  const sendsBeforeClose = await call('sendCount');
  await click('[data-testid="feedback-send"]');
  await call('close');
  await wait(4000);
  report.closedDuringSend = { reachedMain: (await call('sendCount')) !== sendsBeforeClose, stillRendered: await exists('[data-testid="feedback-review"]') };
  expectThat('closing during a Send reaches nothing', !report.closedDuringSend.reachedMain && !report.closedDuringSend.stillRendered, report.closedDuringSend);

  report.violationsDuringUi = await page.evaluate((from) => window.__feedbackEditorPilot.violations.slice(from), violationsBeforeUi);
  expectThat('no CSP violations from the UI', report.violationsDuringUi.length === 0, report.violationsDuringUi);

  if (perf) {
    report.perf = [];
    for (const [w, h] of [[1440, 900], [3024, 1964], [5120, 2880], [6016, 3384]]) {
      report.perf.push(await call('perf', w, h, false));
      report.perf.push(await call('perf', w, h, true));
    }
  }
}
