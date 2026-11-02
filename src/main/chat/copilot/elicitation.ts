import type { ElicitationContext, ElicitationResult } from '@github/copilot-sdk';
import type { ChatQuestion, ChatQuestionAnswers } from '../../../shared/chat/events';

type Schema = NonNullable<ElicitationContext['requestedSchema']>;
type Field = Schema['properties'][string];
type Content = NonNullable<ElicitationResult['content']>;

/** The question card needs an answer to every question, so an optional field gets an explicit way to leave it out. */
const SKIP = '-';
const YES = 'Yes';
const NO = 'No';

function choicesOf(field: Field): Array<{ id: string; label: string }> | undefined {
  if (field.type === 'boolean') return [{ id: YES, label: YES }, { id: NO, label: NO }];
  if (field.type === 'string') {
    if ('oneOf' in field) return field.oneOf.map((o) => ({ id: o.const, label: o.title }));
    if ('enum' in field) return field.enum.map((v, i) => ({ id: v, label: field.enumNames?.[i] ?? v }));
    return undefined;
  }
  if (field.type === 'array') {
    if ('anyOf' in field.items) return field.items.anyOf.map((o) => ({ id: o.const, label: o.title }));
    return field.items.enum.map((v) => ({ id: v, label: v }));
  }
  return undefined;
}

/**
 * A form as question cards, one per field. What a card can't show goes in the
 * prompt: a description and a default as text. Formats and limits aren't shown
 * ahead of time; `elicitationContent` checks them when the form is answered.
 */
export function elicitationQuestions(schema: Schema): ChatQuestion[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, field]) => {
    const optional = !required.has(name);
    const fallback = field.default !== undefined ? ` (default: ${String(field.default)})` : '';
    const choices = choicesOf(field);
    const skip = optional ? (choices ? '' : ` (optional: enter ${SKIP} to skip)`) : '';
    return {
      id: name,
      prompt: `${field.title ?? name}${fallback}${skip}${field.description ? `\n${field.description}` : ''}`,
      ...(field.title && { header: field.title }),
      ...(choices && { options: optional ? [...choices, { id: SKIP, label: 'Skip' }] : choices }),
      multiSelect: field.type === 'array',
      allowFreeText: !choices,
    };
  });
}

function fieldValue(name: string, field: Field, raw: string | string[]): Content[string] {
  const text = Array.isArray(raw) ? raw.join(', ') : raw.trim();
  const label = field.title ?? name;
  switch (field.type) {
    case 'boolean':
      return text === YES;
    case 'number':
    case 'integer': {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) throw new Error(`${label} needs ${field.type === 'integer' ? 'a whole number' : 'a number'}`);
      if (field.minimum !== undefined && n < field.minimum) throw new Error(`${label} must be at least ${field.minimum}`);
      if (field.maximum !== undefined && n > field.maximum) throw new Error(`${label} must be at most ${field.maximum}`);
      return n;
    }
    case 'array': {
      const list = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== SKIP);
      if (field.minItems !== undefined && list.length < field.minItems) throw new Error(`${label} needs at least ${field.minItems}`);
      if (field.maxItems !== undefined && list.length > field.maxItems) throw new Error(`${label} takes at most ${field.maxItems}`);
      return list;
    }
    default:
      if ('minLength' in field && field.minLength !== undefined && text.length < field.minLength) throw new Error(`${label} needs at least ${field.minLength} characters`);
      if ('maxLength' in field && field.maxLength !== undefined && text.length > field.maxLength) throw new Error(`${label} takes at most ${field.maxLength} characters`);
      return text;
  }
}

/** Answers as the form's typed content. Throws on an answer the schema refuses, so the form stays open. */
export function elicitationContent(schema: Schema, answers: ChatQuestionAnswers): Content {
  const required = new Set(schema.required ?? []);
  const content: Content = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    const raw = answers[name];
    const skipped = raw === undefined || raw === SKIP || (typeof raw === 'string' && !raw.trim());
    if (skipped) {
      if (required.has(name)) throw new Error(`${field.title ?? name} is required`);
      continue;
    }
    content[name] = fieldValue(name, field, raw);
  }
  return content;
}
