// Fail closed: assertion failures are only a kill with complete reporter integrity.
export const activeTests = tests => tests.filter(t => !['pending', 'skipped', 'todo'].includes(t.status));
export function assertionReason(test) {
  if (!Array.isArray(test.failures) || !test.failures.length) return null;
  const headers = [];
  for (const message of test.failures) {
    if (typeof message !== 'string') return null;
    const header = message.split(/\n\s+at /)[0];
    if (/\n(?:TypeError|ReferenceError|SyntaxError|Error|AggregateError|Caused by:)/.test(header)) return null;
    const ordinary = /^AssertionError: expected [^\n]* (?:to be [^\n]* \/\/ Object\.is equality|to deeply equal [^\n]*|to have a length of \d+ but got [+-]?\d+|not to be null)$/.test(header);
    const property = test.identity === 'property: normalized non-crossing documents round-trip with paragraphs, breaks and nested lists'
      && /^AssertionError: seed case \d+: [\s\S]+: expected \[ 'doc', null, \[ …\(3\) \] \] to deeply equal \[ 'doc', null, \[ …\(3\) \] \]$/.test(header);
    if (!ordinary && !property) return null;
    headers.push(header);
  }
  return headers;
}
export function testEvidence(tests, exitCode, expectedIdentities) {
  if (!Array.isArray(tests) || tests.some(t => !t || typeof t.identity !== 'string' || !['passed','failed','pending','skipped','todo'].includes(t.status))) return {outcome:'invalid', reason:'malformed test records'};
  const active = activeTests(tests);
  const names = active.map(t=>`${t.file}::${t.identity}`).sort();
  if (!active.length || new Set(names).size !== names.length || JSON.stringify(names)!==JSON.stringify([...expectedIdentities].sort())) return {outcome:'invalid',reason:'missing, extra, duplicate or empty selected identities'};
  if (active.some(t => t.status==='passed' && t.failures?.length)) return {outcome:'invalid',reason:'passing case contains failures'};
  const failures = active.filter(t=>t.status==='failed');
  const reasons = failures.map(t=>({identity:t.identity,headers:assertionReason(t)}));
  if (reasons.some(r=>!r.headers)) return {outcome:'invalid',reason:'unknown or mixed assertion/runtime failure',reasons};
  if (failures.length && exitCode===1) return {outcome:'assertion-kill',reasons};
  if (!failures.length && exitCode===0) return {outcome:'pass',reasons:[]};
  return {outcome:'invalid',reason:'exit status does not match assertion status',reasons};
}
export function reporterIntegrity(data) {
  if (!Array.isArray(data?.testResults) || !data.testResults.length) return 'missing reporter suites';
  if (!Number.isInteger(data.numRuntimeErrorTestSuites) || data.numRuntimeErrorTestSuites!==0 || (!Array.isArray(data.unhandledErrors) || data.unhandledErrors.length!==0)) return 'missing runtime counts or runtime/unhandled error';
  for (const field of ['numTotalTestSuites','numPassedTestSuites','numFailedTestSuites','numPendingTestSuites','numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests']) if(!Number.isInteger(data[field]) || data[field]<0) return 'missing or invalid aggregate counter';
  if(data.numTotalTestSuites<data.testResults.length || data.numTotalTestSuites!==data.numPassedTestSuites+data.numFailedTestSuites+data.numPendingTestSuites || data.numTotalTests!==data.numPassedTests+data.numFailedTests+data.numPendingTests+data.numTodoTests) return 'aggregate counter totals disagree';
  let passed=0, failed=0;
  for (const suite of data.testResults) {
    if (suite.message || !Array.isArray(suite.assertionResults)) return 'suite/import failure';
    const active=suite.assertionResults.filter(t=>!['pending','skipped','todo'].includes(t.status));
    const failures=active.filter(t=>t.status==='failed').length;
    if (suite.status!==(failures?'failed':'passed')) return 'suite status inconsistent with cases';
    passed+=active.filter(t=>t.status==='passed').length; failed+=failures;
  }
  if (data.numPassedTests!==passed || data.numFailedTests!==failed || data.numTotalTests!==data.testResults.reduce((n,s)=>n+s.assertionResults.length,0) || (failed ? !(data.numFailedTestSuites>0) : data.numFailedTestSuites!==0)) return 'inconsistent aggregate counts';
  return null;
}
export function reportVerdict(data, exitCode, tests, expectedIdentities) {
  const error=reporterIntegrity(data);
  return error ? {outcome:'invalid',reason:error} : testEvidence(tests,exitCode,expectedIdentities);
}
