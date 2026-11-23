import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportVerdict, combinedVerdict } from './ci-efficiency-mutation-verdict.mjs';

const name = 'docs-only changes need nothing';
const failure = (message = 'AssertionError: expected { docsOnly: true } to deeply equal { docsOnly: false }') => ({
  fullName: `classify-changes ${name}`, status: 'failed', failureMessages: [message],
});
const report = (assertions = [failure()]) => ({
  numFailedTests: assertions.filter((a) => a.status === 'failed').length,
  numPassedTests: assertions.filter((a) => a.status === 'passed').length,
  numFailedTestSuites: assertions.some((a) => a.status === 'failed') ? 1 : 0,
  numRuntimeErrorTestSuites: 0,
  testResults: [{ status: assertions.some((a) => a.status === 'failed') ? 'failed' : 'passed', message: '', assertionResults: assertions }],
});

const cases = [
  ['expected equality assertion kills', report(), 1, 'killed'],
  ['runtime TypeError is invalid', report([failure('TypeError: cannot read properties of undefined')]), 1, 'invalid'],
  ['runtime ReferenceError is invalid', report([failure('ReferenceError: missing is not defined')]), 1, 'invalid'],
  ['assertion plus runtime in one test is invalid', report([{ ...failure(), failureMessages: [...failure().failureMessages, 'Error: runtime failure'] }]), 1, 'invalid'],
  ['assertion plus runtime in another test is invalid', report([failure(), { ...failure('TypeError: runtime failure'), fullName: 'classify-changes other' }]), 1, 'invalid'],
  ['unrelated matcher is invalid', report([failure('AssertionError: expected true to be false')]), 1, 'invalid'],
  ['known CLI output assertion can accompany expected assertion', report([failure(), { ...failure("AssertionError: expected 'docs_only=false' to be 'docs_only=true' // Object.is equality"), fullName: 'classify-changes the CLI reads a diff on stdin and writes GITHUB_OUTPUT' }]), 1, 'killed'],
  ['CLI runtime mixed with expected assertion is invalid', report([failure(), { ...failure('TypeError: failed reading CLI output'), fullName: 'classify-changes the CLI reads a diff on stdin and writes GITHUB_OUTPUT' }]), 1, 'invalid'],
  ['CLI output shape in an unexpected test is invalid', report([failure(), { ...failure("AssertionError: expected 'docs_only=false' to be 'docs_only=true' // Object.is equality"), fullName: 'classify-changes unrelated' }]), 1, 'invalid'],
  ['wrong test discriminator is invalid', report([{ ...failure(), fullName: 'classify-changes other' }]), 1, 'invalid'],
  ['wrong expected matcher is invalid', report([failure('AssertionError: expected {} to match object {}')]), 1, 'invalid'],
  ['suite error plus assertion is invalid', { ...report(), testResults: [{ ...report().testResults[0], message: 'Error: setup failed' }] }, 1, 'invalid'],
  ['runtime suite count plus assertion is invalid', { ...report(), numRuntimeErrorTestSuites: 1 }, 1, 'invalid'],
  ['failed count mismatch is invalid', { ...report(), numFailedTests: 2 }, 1, 'invalid'],
  ['missing failure messages is invalid', report([{ ...failure(), failureMessages: [] }]), 1, 'invalid'],
  ['malformed failure messages is invalid', report([{ ...failure(), failureMessages: 'TypeError' }]), 1, 'invalid'],
  ['Vitest nested suite counts are accepted', { ...report(), numTotalTestSuites: 2, numFailedTestSuites: 2 }, 1, 'killed'],
  ['exit status disagreement is invalid', report(), 0, 'invalid'],
  ['no selected tests is invalid', report([]), 0, 'invalid'],
  ['malformed report is invalid', {}, 1, 'invalid'],
  ['green report survives', report([{ fullName: `classify-changes ${name}`, status: 'passed', failureMessages: [] }]), 0, 'survived'],
];
for (const [label, data, code, outcome] of cases) {
  test(label, () => assert.equal(reportVerdict(data, code, name, 'deeply equal').outcome, outcome));
}
test('object-match discriminator kills', () => {
  assert.equal(reportVerdict(report([failure('AssertionError: expected {} to match object { e2e: true }')]), 1, name, 'match object').outcome, 'killed');
});
for (const [label, values, expected] of [
  ['matching kills', ['killed', 'killed', 'killed', 'killed'], 'killed'],
  ['matching survivors', ['survived', 'survived', 'survived', 'survived'], 'survived'],
  ['strategy disagreement', ['killed', 'killed', 'survived', 'survived'], 'invalid'],
  ['repeat disagreement', ['killed', 'survived', 'killed', 'killed'], 'invalid'],
  ['invalid plus unresolved', ['invalid', 'unresolved', 'killed', 'killed'], 'invalid'],
  ['disagreement plus timeout', ['killed', 'survived', 'unresolved', 'killed'], 'invalid'],
  ['timeout unresolved', ['unresolved', 'killed', 'killed', 'killed'], 'unresolved'],
]) {
  test(label, () => assert.equal(combinedVerdict({ targeted: values.slice(0, 2).map((outcome) => ({ outcome })), full: values.slice(2).map((outcome) => ({ outcome })) }), expected));
}
