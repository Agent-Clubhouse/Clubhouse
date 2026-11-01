/**
 * Who sent a chat message, and the message without its routing text (#2599).
 *
 * Messages between agents reach the receiving CLI tagged (`[TASK:...]`,
 * `[FROM:...]`, reply instructions). That text is for the agent. Chat shows
 * the sender and the message itself, from the `routed` parts of the
 * `user_message` event. Transcripts written before `routed` existed, and
 * deliveries that don't set it, fall back to parsing the text here.
 */

import type { MessageSource, MessageSender, RoutedMessagePart } from './events';

/** How a message reads in chat: the user's own, or from others. */
export type MessageDisplay =
  | { from: 'you'; text: string }
  | { from: 'others'; parts: RoutedMessagePart[] };

const SECTION_HEADER = /^(\d+) updates, oldest first:\n\n/;

/** A coalesced message's sections (see coalesce.ts), or the text itself when it isn't one. */
function splitCoalesced(text: string): string[] {
  const header = SECTION_HEADER.exec(text);
  if (!header) return [text];
  const count = Number(header[1]);
  let rest = text.slice(header[0].length);
  const sections: string[] = [];
  for (let i = 1; i <= count; i++) {
    const label = `--- ${i} of ${count} ---\n`;
    if (!rest.startsWith(label)) return [text];
    rest = rest.slice(label.length);
    const next = i < count ? rest.indexOf(`\n\n--- ${i + 1} of ${count} ---\n`) : rest.length;
    if (next === -1) return [text];
    sections.push(rest.slice(0, next));
    rest = rest.slice(next + 2);
  }
  return sections;
}

const CLUBHOUSE_TAG = /^\[Clubhouse\] /;
const HELPER_TAG = /^\[FROM HELPER:([^\]]+?) \(([^)\]]+)\)\] /;
const QUESTION_TAG = /^\[QUESTION FROM HELPER:([^\]]+?) \(([^)\]]+)\)\] .*? is waiting for your answer\. Answer with answer_helper_question, requestId "[^"]*"\. If the user should decide, call it with escalate: true instead\.\n?/;
const FROM_TAG = /^(?:\[TASK:[^\]]+\] )?\[FROM:([^\]]+)\] /;
const REPLY_FOOTER = /\n\n---\nReply to [^\n]* via tool "[^"\n]*" with task_id="[^"\n]*"\. Prefix your response with TASK_RESULT:\S*\.$/;
/** A woken helper's saved task can be followed by the waker's own tagged message. */
const HELPER_MISSION_FOOTER = /\n\n---\nYou are a helper agent started by [^\n]*\. Use the message_parent tool to send [^\n]* your progress, questions and results\.(?:\n\n\[FROM:[^\]]+\] )?/;
const FILE_NOTICE = /^File delivered: ([^\n]*) — read this file for content from [^\n]*\.$/;
const TAP = /^Group Project notification — shoulder tap from "([^"\n]*)" in "[^"\n]*"\n([\s\S]*?)\n\n---\nRESPONSE INSTRUCTIONS:\n[\s\S]*$/;
const TASK_MARKER = /^TASK_(?:RESULT|ACK):[^\s:]+(?::\s*|\s+|$)/;

/** `name@project` is how a `[FROM:...]` label reads; the name is what chat shows. */
function nameFromLabel(label: string): string {
  const at = label.lastIndexOf('@');
  return at > 0 ? label.slice(0, at) : label;
}

/** The text an agent starts its reply with so a poller can find it. Chat doesn't show it. */
export function stripTaskMarker(text: string): string {
  return text.replace(TASK_MARKER, '');
}

function parseSection(section: string): RoutedMessagePart {
  if (CLUBHOUSE_TAG.test(section)) return { fromClubhouse: true, text: section.replace(CLUBHOUSE_TAG, '') };
  const helper = HELPER_TAG.exec(section) ?? QUESTION_TAG.exec(section);
  if (helper) return { sender: { agentId: helper[2], name: helper[1] }, text: section.slice(helper[0].length) };
  const from = FROM_TAG.exec(section);
  if (from) {
    const body = section.slice(from[0].length)
      .replace(REPLY_FOOTER, '')
      .replace(HELPER_MISSION_FOOTER, (footer) => (footer.endsWith('] ') ? '\n\n' : ''));
    return { sender: { name: nameFromLabel(from[1]) }, text: body.replace(FILE_NOTICE, 'File delivered: $1') };
  }
  return { text: section };
}

/** Parse tagged message text into parts, for messages that carry no `routed` data. */
export function parseRoutedText(text: string): RoutedMessagePart[] {
  return splitCoalesced(text).map(parseSection);
}

/** A part as it is shown: without a reply marker leading the message. */
function shown(part: RoutedMessagePart): RoutedMessagePart {
  const text = stripTaskMarker(part.text);
  return text === part.text ? part : { ...part, text };
}

/**
 * How a user_message reads in chat. Structured `routed` data wins over the
 * text, which keeps what a sender puts in its own message from passing as
 * routing. Text the user typed is never parsed.
 */
export function messageDisplay(message: { source: MessageSource; text: string; routed?: RoutedMessagePart[] }): MessageDisplay {
  const { source, text, routed } = message;
  if (source === 'user' || source === 'annex') return { from: 'you', text };
  if (routed?.length) return { from: 'others', parts: routed.map(shown) };
  if (source === 'system') return { from: 'others', parts: [{ fromClubhouse: true, text }] };
  if (source === 'group_project') return { from: 'others', parts: [{ text }] };
  if (source === 'shoulder_tap') {
    const tap = TAP.exec(text);
    if (!tap) return { from: 'others', parts: [{ text }] };
    // A tap from the Clubhouse UI is the user's own.
    if (tap[1] === 'user') return { from: 'you', text: tap[2] };
    return { from: 'others', parts: [{ sender: { name: nameFromLabel(tap[1]) }, text: tap[2] }] };
  }
  const parts = parseRoutedText(text).map(shown);
  // A mission the user wrote carries no tag.
  if (source === 'mission' && !parts.some((p) => p.sender || p.fromClubhouse)) return { from: 'you', text };
  return { from: 'others', parts };
}

/** A message on one line, such as a queue row: `name: text` for each part. */
export function messageSummary(message: { source: MessageSource; text: string; routed?: RoutedMessagePart[] }): string {
  const display = messageDisplay(message);
  if (display.from === 'you') return display.text;
  return display.parts.map((part) => {
    const name = senderDisplayName(part);
    return name ? `${name}: ${part.text}` : part.text;
  }).join(' · ');
}

/** The name carried on a part, when it has one. */
export function senderDisplayName(part: { sender?: MessageSender; fromClubhouse?: boolean }): string | undefined {
  return part.sender?.name ?? (part.fromClubhouse ? 'Clubhouse' : undefined);
}
