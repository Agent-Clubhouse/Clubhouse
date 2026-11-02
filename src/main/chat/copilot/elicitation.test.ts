import { describe, expect, it } from 'vitest';
import { elicitationContent, elicitationQuestions } from './elicitation';

const schema = {
  type: 'object' as const,
  properties: {
    name: { type: 'string' as const, title: 'Name', description: 'Your name', minLength: 2, maxLength: 4 },
    count: { type: 'number' as const, minimum: 1, maximum: 5, default: 2 },
    pick: { type: 'string' as const, oneOf: [{ const: 'a', title: 'Option A' }] },
    named: { type: 'string' as const, enum: ['x'], enumNames: ['Ex'] },
    many: { type: 'array' as const, minItems: 1, maxItems: 2, items: { type: 'string' as const, enum: ['p', 'q', 'r'] } },
    flag: { type: 'boolean' as const },
    extra: { type: 'string' as const },
    extraChoice: { type: 'string' as const, enum: ['y'] },
  },
  required: ['name', 'count', 'pick', 'named', 'many', 'flag'],
};
const valid = { name: 'Ann', count: '3', pick: 'a', named: 'x', many: ['p', 'q'], flag: 'No' };

describe('copilot elicitation', () => {
  it('turns each field into a question, with what a card can\'t show in its prompt', () => {
    const q = new Map(elicitationQuestions(schema).map((x) => [x.id, x]));
    expect(q.get('name')).toMatchObject({ prompt: 'Name\nYour name', allowFreeText: true, multiSelect: false });
    expect(q.get('count')?.prompt).toContain('default: 2');
    expect(q.get('pick')?.options).toEqual([{ id: 'a', label: 'Option A' }]);
    expect(q.get('named')?.options).toEqual([{ id: 'x', label: 'Ex' }]);
    expect(q.get('many')).toMatchObject({ multiSelect: true, allowFreeText: false });
    expect(q.get('extra')?.prompt).toContain('optional');
    expect(q.get('extraChoice')?.options?.map((o) => o.label)).toEqual(['y', 'Skip']);
  });

  it('returns typed values and leaves out what was skipped', () => {
    expect(elicitationContent(schema, { ...valid, extra: '-', extraChoice: '-' })).toEqual({ name: 'Ann', count: 3, pick: 'a', named: 'x', many: ['p', 'q'], flag: false });
    expect(elicitationContent(schema, { ...valid, extra: 'hi' }).extra).toBe('hi');
  });

  it.each([
    [{ name: '-' }, /Name is required/],
    [{ name: 'A' }, /at least 2/],
    [{ name: 'Annabel' }, /at most 4/],
    [{ count: 'x' }, /a number/],
    [{ count: '0' }, /at least 1/],
    [{ count: '9' }, /at most 5/],
    [{ many: [] }, /at least 1/],
    [{ many: ['p', 'q', 'r'] }, /at most 2/],
  ])('refuses %j', (bad, message) => {
    expect(() => elicitationContent(schema, { ...valid, ...bad })).toThrow(message);
  });
});
