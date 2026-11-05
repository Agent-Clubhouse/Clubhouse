import { describe, expect, it } from 'vitest';
import { BLOCK_SEPARATOR, composedBytes, composeInstructions, MAX_COMPOSED_BYTES } from './composer';
import { MAX_BLOCK_BYTES } from './validation';

describe('composeInstructions', () => {
  it('joins in the order given with the fixed separator and adds nothing else', () => {
    const result = composeInstructions([{ content: 'One' }, { content: 'Two' }, { content: 'Three' }]);
    expect(result).toEqual({ ok: true, text: `One${BLOCK_SEPARATOR}Two${BLOCK_SEPARATOR}Three`, bytes: 'One\n\nTwo\n\nThree'.length });
    expect(BLOCK_SEPARATOR).toBe('\n\n');
  });

  it('order is what decides the bytes', () => {
    const forward = composeInstructions([{ content: 'A' }, { content: 'B' }]);
    const backward = composeInstructions([{ content: 'B' }, { content: 'A' }]);
    expect(forward.ok && forward.text).toBe('A\n\nB');
    expect(backward.ok && backward.text).toBe('B\n\nA');
  });

  it('is byte-stable across runs', () => {
    const blocks = [{ content: 'First\r\nline  \n' }, { content: '\tTrailing\n\n' }];
    expect(composeInstructions(blocks)).toEqual(composeInstructions(blocks.map((block) => ({ ...block }))));
  });

  it('a single block is byte-identical: a whole document can be one block', () => {
    const document = '# Persona\r\n\r\nKeeps odd  spacing, a trailing newline\n\n';
    expect(composeInstructions([{ content: document }])).toMatchObject({ ok: true, text: document });
  });

  it('leaves wildcards unexpanded', () => {
    const result = composeInstructions([{ content: 'You are @@AgentName in @@Path.' }, { content: '@@Project' }]);
    expect(result.ok && result.text).toBe('You are @@AgentName in @@Path.\n\n@@Project');
  });

  it('an empty list composes to nothing, not to a separator', () => {
    expect(composeInstructions([])).toEqual({ ok: true, text: '', bytes: 0 });
  });

  it('takes content alone: a name or role on a block changes nothing', () => {
    const plain = composeInstructions([{ content: 'Text' }]);
    const named = composeInstructions([{ content: 'Text', name: 'Orchestrator', role: 'admin', access: 'bypass' } as { content: string }]);
    expect(named).toEqual(plain);
  });

  it('refuses an oversized block, naming its position and not its text', () => {
    const result = composeInstructions([{ content: 'ok' }, { content: `secret-words${'x'.repeat(MAX_BLOCK_BYTES)}` }]);
    expect(result).toEqual({ ok: false, code: 'block_too_large', index: 1 });
    expect(JSON.stringify(result)).not.toContain('secret-words');
  });

  it('refuses a total over the limit, counting bytes and not characters', () => {
    const block = { content: 'x'.repeat(MAX_BLOCK_BYTES) };
    expect(composeInstructions([block, block])).toEqual({ ok: false, code: 'composed_too_large' });
    expect(composeInstructions([{ content: 'é'.repeat(MAX_BLOCK_BYTES / 2 + 1) }])).toEqual({ ok: false, code: 'block_too_large', index: 0 });
  });

  it('sizes without text agree with composing', () => {
    const blocks = [{ content: 'aé' }, { content: 'b' }];
    const result = composeInstructions(blocks);
    expect(result.ok && result.bytes).toBe(composedBytes(blocks.map((block) => Buffer.byteLength(block.content))));
    expect(composedBytes([])).toBe(0);
    expect(composedBytes([MAX_COMPOSED_BYTES])).toBe(MAX_COMPOSED_BYTES);
  });
});
