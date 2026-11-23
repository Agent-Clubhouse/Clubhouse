// Conservative verdicts for this pilot's known Vitest expect assertions only.
export function reportVerdict(data, exitCode, expectedName, expectedMatcher) {
  if (!Array.isArray(data?.testResults) || data.testResults.length !== 1
      || !Array.isArray(data.testResults[0]?.assertionResults)
      || data.testResults[0].assertionResults.some((test) => !test || typeof test.fullName !== 'string')) {
    return { outcome: 'invalid', reason: 'unexpected reporter structure' };
  }
  const suite = data.testResults[0];
  const assertions = suite.assertionResults;
  const failures = assertions.filter((test) => test.status === 'failed');
  const passed = assertions.filter((test) => test.status === 'passed').length;
  const failed = failures.map((test) => ({ name: test.fullName, messages: test.failureMessages }));
  const evidence = { passed, failed, reportCounts: { failedTests: data.numFailedTests, passedTests: data.numPassedTests, failedSuites: data.numFailedTestSuites, totalSuites: data.numTotalTestSuites }, suiteStatus: suite.status };
  if (suite.message || data.numRuntimeErrorTestSuites > 0
      || assertions.some((test) => !['passed', 'failed', 'pending', 'todo', 'skipped'].includes(test.status))
      || data.numFailedTests !== failures.length
      || data.numPassedTests !== passed) {
    return { ...evidence, outcome: 'invalid', reason: 'suite/runtime failure or inconsistent report counts' };
  }
  if (failures.length) {
    // Every failed case must have only the suite's known expect messages.
    // A runtime exception in any case invalidates even a simultaneous real kill.
    const expectFailure = /^AssertionError: expected [\s\S]+ to (?:deeply equal|match object) /;
    const cliOutputFailure = /^AssertionError: expected 'docs_only=[\s\S]+ to be '[\s\S]+ \/\/ Object.is equality(?:\n|$)/;
    const allAssertions = failures.every((test) => Array.isArray(test.failureMessages)
      && test.failureMessages.length > 0 && test.failureMessages.every((message) => typeof message === 'string'
        && (expectFailure.test(message) || (test.fullName === 'classify-changes the CLI reads a diff on stdin and writes GITHUB_OUTPUT' && cliOutputFailure.test(message)))));
    const expected = failures.find((test) => test.fullName === `classify-changes ${expectedName}`);
    const discriminated = Array.isArray(expected?.failureMessages) && expected.failureMessages.every((message) => typeof message === 'string' && message.includes(` to ${expectedMatcher} `));
    // Vitest counts both the file and its describe block as failed suites.
    if (exitCode === 1 && allAssertions && discriminated && suite.status === 'failed' && data.numFailedTestSuites > 0) {
      return { ...evidence, outcome: 'killed', discriminator: { test: expected.fullName, matcher: expectedMatcher } };
    }
    return { ...evidence, outcome: 'invalid', reason: 'unexpected assertion, runtime error, mixed failure, or missing expected discriminator' };
  }
  if (exitCode === 0 && passed > 0 && suite.status === 'passed' && data.numFailedTestSuites === 0) {
    return { ...evidence, outcome: 'survived' };
  }
  return { ...evidence, outcome: 'invalid', reason: 'suite/import/infrastructure failure or no selected tests' };
}

export function combinedVerdict(runs) {
  const outcomes = Object.values(runs).flat().map((run) => run.outcome);
  if (outcomes.includes('invalid') || new Set(outcomes.filter((outcome) => ['killed', 'survived'].includes(outcome))).size > 1) return 'invalid';
  if (outcomes.includes('unresolved')) return 'unresolved';
  // Repeated instability and targeted/full disagreement both invalidate scoring.
  return outcomes.length === 4 && new Set(outcomes).size === 1
    && ['killed', 'survived'].includes(outcomes[0]) ? outcomes[0] : 'invalid';
}
