import { describe, expect, it } from 'vitest';
import { HANDOFF_SECRET_CONTENT_MAX_BYTES, safeHandoffDiagnosticPath, scanHandoffSecrets, type HandoffSecretRule } from './handoff-secrets';

const bytes = (value: string) => new TextEncoder().encode(value);
const base64url = (value: string) => btoa(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (alg: string) => `${base64url(JSON.stringify({ alg, typ: 'JWT' }))}.${base64url('{"sub":"example"}')}.${'a'.repeat(43)}`;

describe('fixed handoff secret rules', () => {
  const pathCases: Array<[HandoffSecretRule, string, string]> = [
    ['path.env', 'nested/.ENV.production', 'nested/.env.example'],
    ['path.private_key', 'keys/cert.PEM', 'keys/cert.pub'],
    ['path.pkcs12', 'keys/cert.PFX', 'keys/cert.crt'],
    ['path.ssh_identity', 'keys/ID_ED25519.backup', 'keys/public_ed25519.pub'],
    ['path.keystore', 'certs/demo.KEYSTORE', 'certs/demo.store'],
    ['path.credentials_json', 'config/Credentials.dev.JSON', 'config/credentials.example.txt'],
    ['path.service_account_json', 'config/my-Service-Account.dev.JSON', 'config/service-account.txt'],
    ['path.aws', 'home/.AWS/config', 'home/aws/config'],
    ['path.ssh', 'home/.SSH/config', 'home/ssh/config'],
    ['path.gnupg', 'home/.GNUPG/data', 'home/gnupg/data'],
    ['path.docker_config', 'home/.Docker/Config.JSON', 'home/.docker/daemon.json'],
    ['path.terraform_state', 'state/main.TFSTATE.backup', 'state/main.tf'],
    ['path.password_database', 'data/passwords.KDBX', 'data/passwords.csv'],
  ];

  it.each(pathCases)('%s has positive and negative path fixtures', (rule, positive, negative) => {
    expect(scanHandoffSecrets(positive, bytes('example'))).toContainEqual({ path: positive, rule });
    expect(scanHandoffSecrets(negative, bytes('example'))).toEqual([]);
  });

  const contentCases: Array<[HandoffSecretRule, string, string]> = [
    ['content.private_key', '-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN PUBLIC KEY-----'],
    ['content.aws_access_key', `AKIA${'A'.repeat(16)}`, `AKIA${'A'.repeat(15)}`],
    ['content.google_api_key', `AIza${'A'.repeat(35)}`, 'AIza-replace-me'],
    ['content.ai_api_key', `sk-proj-${'a'.repeat(64)}`, 'sk-proj-placeholder'],
    ['content.cloud_account_key', `AccountKey=${'A'.repeat(43)}=`, 'AccountName=example'],
    ['content.github_token', `ghp_${'a'.repeat(36)}`, 'ghp_example'],
    ['content.gitlab_token', `glpat-${'a'.repeat(20)}`, 'glpat-example'],
    ['content.npm_token', `npm_${'a'.repeat(36)}`, 'npm_example'],
    ['content.pypi_token', `pypi-${'a'.repeat(50)}`, 'pypi-example'],
    ['content.slack_token', `xoxb-${'1'.repeat(12)}-${'2'.repeat(12)}-${'a'.repeat(24)}`, 'xoxb-example'],
    ['content.stripe_live_key', `sk_live_${'a'.repeat(24)}`, `sk_test_${'a'.repeat(24)}`],
    ['content.connection_password', 'postgres://example:synthetic-password@db.example/app', 'postgres://example@db.example/app'],
    ['content.database_password', 'Server=db.example;User Id=example;Password=synthetic-password;', 'Server=db.example;User Id=example;Integrated Security=true;'],
    ['content.signed_jwt', jwt('HS256'), jwt('none')],
  ];

  it.each(contentCases)('%s has positive and negative content fixtures with no matched values in reports', (rule, positive, negative) => {
    const findings = scanHandoffSecrets('src/example.txt', bytes(`safe first line\r\n${positive}\n`));
    expect(findings).toContainEqual({ path: 'src/example.txt', rule, line: 2 });
    expect(JSON.stringify(findings)).not.toContain(positive);
    expect(scanHandoffSecrets('src/example.txt', bytes(negative))).toEqual([]);
  });

  it.each(['.env.example', '.env.sample', '.env.template'])('allows %s by name, but still scans its contents', (path) => {
    expect(scanHandoffSecrets(path, bytes('EXAMPLE=placeholder'))).toEqual([]);
    expect(scanHandoffSecrets(path, bytes(`TOKEN=ghp_${'a'.repeat(36)}`)).map((finding) => finding.rule)).toContain('content.github_token');
  });

  it.each(['.npmrc', '.pypirc', '.netrc'])('blocks auth in %s without blocking empty or environment-reference configuration', (path) => {
    const content = path === '.netrc' ? 'machine example login example password synthetic-password' : '_authToken=synthetic-password';
    expect(scanHandoffSecrets(path, bytes(content))).toEqual([{ path, rule: 'content.auth_config', line: 1 }]);
    expect(scanHandoffSecrets(path, bytes('registry=https://registry.example/\n_authToken=${NPM_TOKEN}'))).toEqual([]);
    expect(scanHandoffSecrets(path, new Uint8Array([0, 1, 2]))).toEqual([{ path, rule: 'path.auth_config_uninspectable' }]);
  });

  it('scans exact-size text and applies name-only policy to oversized or binary content', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const atLimit = bytes(`${' '.repeat(HANDOFF_SECRET_CONTENT_MAX_BYTES - token.length)}${token}`);
    expect(scanHandoffSecrets('large.txt', atLimit).map((finding) => finding.rule)).toContain('content.github_token');
    expect(scanHandoffSecrets('large.txt', bytes(`${' '.repeat(HANDOFF_SECRET_CONTENT_MAX_BYTES)}${token}`))).toEqual([]);
    expect(scanHandoffSecrets('binary.bin', new Uint8Array([0, ...bytes(token)]))).toEqual([]);
    expect(scanHandoffSecrets('private.key', new Uint8Array([0, 1]))).toEqual([{ path: 'private.key', rule: 'path.private_key' }]);
    expect(scanHandoffSecrets('.npmrc', bytes(' '.repeat(HANDOFF_SECRET_CONTENT_MAX_BYTES + 1)))).toEqual([{ path: '.npmrc', rule: 'path.auth_config_uninspectable' }]);
  });

  it('blocks credential-shaped filenames and redacts their values in diagnostics', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const path = `data/${token}.txt`;
    expect(scanHandoffSecrets(path)).toEqual([{ path: 'data/[redacted].txt', rule: 'path.secret_token' }]);
    expect(safeHandoffDiagnosticPath(path)).not.toContain(token);
  });

  it('rejects invalid paths with a fixed message instead of reflecting input', () => {
    expect(() => scanHandoffSecrets('../outside')).toThrow('Invalid handoff file path.');
    expect(scanHandoffSecrets('data.txt', bytes('not.a.jwt\ninvalid eyJbroken.broken.broken'))).toEqual([]);
  });
});
