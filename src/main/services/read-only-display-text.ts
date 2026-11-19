/** Shared conservative display policy, extracted unchanged from reviewed Changes. */
import { isSecretKey, redactSecretValues } from '../telemetry/diag-redaction';

/** Source/JSON names may include suffixes (awsSecretAccessKey2), and quoted values may span lines. */
export function redactChangeText(text: string): string | null {
  // Mask complete key blocks before inspecting key names. Their body is never
  // interpreted as source, and no cut/diff can expose a middle fragment.
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<redacted>');
  // This is a display projector, not a language parser. Only a complete literal
  // with an explicit end/delimiter is classified. Every other credential
  // initializer withholds the patch, including parentheses, comments, operators,
  // identifiers and typed declarations. Metadata/counts remain available.
  const values = /(?<![\p{L}\p{N}_$.-])([\p{L}\p{N}_$.-]+)(["']?\s*(?:\?\?=|\|\|=|&&=|\+=|[:=])\s*)/gu;
  let safe = '', copied = 0, secretValues = 0;
  const classified: Array<[number, number]> = [];
  for (let match = values.exec(text); match; match = values.exec(text)) {
    if (!isSecretKey(match[1])) continue;
    if (++secretValues > 2000) return null;
    if (!/^["']?\s*[:=]\s*$/.test(match[2])) return null;
    const valueStart = values.lastIndex;
    const quote = text[valueStart];
    if (quote !== '"' && quote !== "'" && quote !== '`') return null;
    let end = valueStart + 1, closed = false;
    while (end < text.length) {
      if (text[end] === '\\') { end = Math.min(text.length, end + 2); continue; }
      if (text[end++] === quote) { closed = true; break; }
    }
    if (!closed || quote === '`' && text.slice(valueStart, end).includes('${')) return null;
    // Never skip comments: they can hide a continuation operator. A newline
    // alone also does not terminate an expression in languages such as JS.
    const next = text.slice(end).match(/^\s*([^\s]|$)/)?.[1];
    if (next !== '' && next !== ';') return null;
    safe += text.slice(copied, match.index) + match[1] + match[2] + quote + '<redacted>' + quote;
    classified.push([match.index, end]);
    copied = end; values.lastIndex = end;
  }
  // Account for *every* known credential-key mention, regardless of assignment
  // syntax. Indexed keys, unsupported operators, tuple declarations, arguments
  // and future language forms must not fall through a generic scrubber. Only
  // the exact classified spans may contain such names or values.
  let unclassified = '', boundary = 0;
  for (const [start, end] of classified) { unclassified += text.slice(boundary, start) + ' '; boundary = end; }
  unclassified += text.slice(boundary);
  // An escape can encode all or part of a key/identifier in another language.
  // Without a language parser its role is unknown, including otherwise benign
  // source strings. Only escapes inside an already redacted value are covered.
  if (unclassified.includes('\\')) return null;
  for (const candidate of unclassified.matchAll(/[\p{L}\p{N}_$.-]+/gu)) if (isSecretKey(candidate[0])) return null;
  // Quoted keys may have whitespace or punctuation which normalization removes.
  for (const candidate of unclassified.matchAll(/"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|`((?:\\[\s\S]|[^`\\])*)`/g)) {
    if (isSecretKey(candidate[1] ?? candidate[2] ?? candidate[3])) return null;
  }
  return redactSecretValues(safe + text.slice(copied));
}
