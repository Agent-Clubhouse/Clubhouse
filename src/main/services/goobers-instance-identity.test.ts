import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractSpecInstanceIdentity, readInstanceIdentitySummary } from './goobers-instance-identity';

const REFERENCE_MANIFEST = fs.readFileSync(
  path.join(__dirname, '../../shared/__fixtures__/goobers/manifest.yaml'),
  'utf-8',
);

describe('extractSpecInstanceIdentity', () => {
  it('extracts name and environment from the reference instance manifest', () => {
    expect(extractSpecInstanceIdentity(REFERENCE_MANIFEST)).toEqual({
      name: 'goobers-local',
      environment: 'dev',
    });
  });

  it('returns null for empty content', () => {
    expect(extractSpecInstanceIdentity('')).toBeNull();
  });

  it('returns null when there is no spec.instance block', () => {
    const yaml = 'apiVersion: goobers.dev/v1alpha1\nkind: Manifest\nmetadata:\n  name: x\n';
    expect(extractSpecInstanceIdentity(yaml)).toBeNull();
  });

  it('returns null when spec exists but has no instance sub-block', () => {
    const yaml = 'spec:\n  gaggles:\n    - a\n    - b\n';
    expect(extractSpecInstanceIdentity(yaml)).toBeNull();
  });

  it('returns a partial result when name is present but environment is absent', () => {
    const yaml = 'spec:\n  instance:\n    name: only-a-name\n  gaggles:\n    - a\n';
    expect(extractSpecInstanceIdentity(yaml)).toEqual({ name: 'only-a-name', environment: undefined });
  });

  it('returns a partial result when environment is present but name is absent', () => {
    const yaml = 'spec:\n  instance:\n    environment: prod\n';
    expect(extractSpecInstanceIdentity(yaml)).toEqual({ name: undefined, environment: 'prod' });
  });

  it('strips surrounding quotes from scalar values', () => {
    const yaml = 'spec:\n  instance:\n    name: "quoted-name"\n    environment: \'staging\'\n';
    expect(extractSpecInstanceIdentity(yaml)).toEqual({ name: 'quoted-name', environment: 'staging' });
  });

  it('does not pick up name/environment from an unrelated block at the same indentation', () => {
    const yaml = 'spec:\n  connections:\n    - name: repo-token\n      environment: unrelated\n  instance:\n    name: real-name\n    environment: real-env\n';
    expect(extractSpecInstanceIdentity(yaml)).toEqual({ name: 'real-name', environment: 'real-env' });
  });

  it('returns null for malformed/unparseable content', () => {
    expect(extractSpecInstanceIdentity('not: [valid, yaml, at: all: :::')).toBeNull();
    expect(extractSpecInstanceIdentity('\t\t\t   ')).toBeNull();
  });
});

describe('readInstanceIdentitySummary', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-identity-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads a well-formed config/manifest.yaml', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'config'));
    fs.writeFileSync(path.join(tmpRoot, 'config', 'manifest.yaml'), REFERENCE_MANIFEST);

    const result = await readInstanceIdentitySummary(tmpRoot);

    expect(result).toEqual({ name: 'goobers-local', environment: 'dev' });
  });

  it('returns null when config/manifest.yaml is absent — not an error, not a crash', async () => {
    const result = await readInstanceIdentitySummary(tmpRoot);
    expect(result).toBeNull();
  });

  it('returns null for malformed YAML content rather than throwing', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'config'));
    fs.writeFileSync(path.join(tmpRoot, 'config', 'manifest.yaml'), ':::not valid at all:::\n');

    const result = await readInstanceIdentitySummary(tmpRoot);

    expect(result).toBeNull();
  });

  it('returns null when spec.instance is missing from an otherwise valid file', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'config'));
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'manifest.yaml'),
      'apiVersion: goobers.dev/v1alpha1\nkind: Manifest\nspec:\n  gaggles:\n    - a\n',
    );

    const result = await readInstanceIdentitySummary(tmpRoot);

    expect(result).toBeNull();
  });

  it('never throws even when config/manifest.yaml is unreadable (e.g. a directory)', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'config'));
    fs.mkdirSync(path.join(tmpRoot, 'config', 'manifest.yaml'));

    await expect(readInstanceIdentitySummary(tmpRoot)).resolves.toBeNull();
  });
});
