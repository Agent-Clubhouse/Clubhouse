import { describe, expect, it } from 'vitest';
import { redactLogValue, redactSpawnArgs, LogRedactor } from './log-redaction';

describe('spawn log redaction', () => {
  it.each(['-p', '--print', '--prompt', '--system-prompt', '--append-system-prompt', '--mission', '--message', '--instructions', '--provider-prompt'])('redacts %s in split and equals form', (flag) => {
    const marker = `PRIVATE-${flag}-mission`;
    const original = [flag, marker, `${flag}=${marker}`, '--model', 'opus', '--cwd=/work'];
    const logged = redactSpawnArgs(original);
    expect(JSON.stringify(logged)).not.toContain(marker);
    expect(logged).toEqual([flag, `<redacted: ${marker.length} chars>`, `${flag}=<redacted: ${marker.length} chars>`, '--model', 'opus', '--cwd=/work']);
    expect(original[1]).toBe(marker);
  });

  it('redacts positional prompts, shell wrappers and unknown configuration values', () => {
    const marker = 'POSITIONAL-PRIVATE';
    expect(redactSpawnArgs(['exec', '--json', marker, '--', '--model=secret'])).toEqual([
      '<redacted: 4 chars>', '--json', `<redacted: ${marker.length} chars>`, '--', '<redacted: 14 chars>',
    ]);
    expect(JSON.stringify(redactSpawnArgs(['-c', `instructions=${marker}`, '-e', `echo ${marker}`]))).not.toContain(marker);
  });

  it('redacts flag-looking prompt values and preserves summaries across layers', () => {
    const args = ['--system-prompt', '--model=PRIVATE', '-p=--cwd=PRIVATE'];
    const safe = redactSpawnArgs(args);
    expect(JSON.stringify(safe)).not.toContain('PRIVATE');
    expect(redactSpawnArgs(safe)).toEqual(safe);
    expect(redactLogValue('')).toBe('<redacted: 0 chars>');
  });

  it('recognizes Codex system instructions in config overrides for diagnostic scrubbing', () => {
    const marker = 'CODEX-CONFIG-PRIVATE-SYSTEM';
    const redactor = new LogRedactor(['-c', 'developer_instructions=' + JSON.stringify(marker)]);
    expect(redactor.text(`warning: ${marker}`)).toBe(`warning: <redacted: ${marker.length} chars>`);
  });

  it('scrubs known multi-line and JSON-escaped request content before truncation', () => {
    const marker = 'PRIVATE-"QUOTED"-PROMPT\nsecond line';
    const redactor = new LogRedactor();
    redactor.remember({ task: marker, message: 'PRIVATE-MESSAGE' });
    expect(redactor.text(`failure: ${JSON.stringify(marker)} PRIVATE-MESSAGE`)).not.toContain('PRIVATE');
    expect(redactor.text(`failure: ${marker}`, 35)).not.toContain('PRIVATE');
    expect(redactor.text('unrelated short stderr')).toBe('unrelated short stderr');
  });

  it('redacts transport payloads and errors, keeping structural diagnostics', () => {
    const marker = 'TRANSPORT-PRIVATE';
    const meta = { id: 3, method: 'turn/start', error: marker, message: marker, data: { prompt: marker }, stderr: marker, line: marker, args: ['-p', marker], model: 'opus' };
    const redactor = new LogRedactor(meta.args);
    redactor.rememberText(marker);
    const logged = redactor.meta(meta)!;
    expect(JSON.stringify(logged)).not.toContain(marker);
    expect(logged).toMatchObject({ id: 3, method: 'turn/start', model: 'opus', message: `<redacted: ${marker.length} chars>`, data: '<redacted: 1 keys>' });
    expect(meta.message).toBe(marker);
  });
});
