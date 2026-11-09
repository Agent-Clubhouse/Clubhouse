/**
 * What never shows in the Dispatcher's chat (#3043): tool calls, JSON, task
 * ids and reply instructions. Messages between agents carry that text for the
 * agents (routing tags, `task_id=...`, "Reply to ... via tool ...", tool
 * output), and none of it means anything to the person reading the chat.
 *
 * Pure text rules, used in main on an agent's news before it reaches the
 * chat, and in the renderer on what the chat shows.
 */

/** A routing tag at the start of a message or line: `[FROM:x]`, `[TASK:x]`, `[HAND-OFF]`, `[Clubhouse]`, ... */
const ROUTING_TAG = /^\s*(?:\[(?:FROM(?: HELPER)?:[^\]\n]*|TASK:[^\]\n]*|QUESTION FROM HELPER:[^\]\n]*|HAND-OFF|Clubhouse)\]\s*)+/gim;
/** The marker a reply starts with so a poller can find it: `TASK_RESULT:t_abc: `. */
const TASK_MARKER = /^\s*TASK_(?:RESULT|ACK):[^\s:]+:?\s*/gim;
/** `task_id=t_abc`, `task_id: "t_abc"`, `(task_id t_abc)`, `requestId "r_1"`. */
const TASK_ID = /\(?\b(?:task_?id|request_?id)\b(?:\s*[:=]\s*["']?[\w-]+["']?|\s+["'][\w-]+["']|\s+(?=[\w-]*[\d_])[\w-]+)\)?/gi;
/** A generated id on its own: `t_lw3k2j9`, `handoff_lw3k2j9` (always has a digit). */
const BARE_ID = /\(?\b(?:t|handoff|task|req)_(?=[a-z0-9]*\d)[a-z0-9]{6,}\b\)?/gi;
/** A provider's name for a tool: `mcp__clubhouse__send_message`, `clubhouse__x__read_output`. */
const TOOL_NAME = /`?\bmcp__[\w-]+`?|`?\bclubhouse__[\w-]+`?/gi;
/** A line that tells the reader how to answer: for an agent, never the person. */
const REPLY_LINE = /^\s*(?:-{3,}\s*$|(?:reply|respond|answer)(?: to [^\n]*?)? (?:via|with|using) (?:tool|send_message|the [\w ]*tool|answer_|message_)[^\n]*$|to reply,[^\n]*$|prefix your (?:response|reply) with[^\n]*$|response instructions:[^\n]*$|use the message_parent tool[^\n]*$)/gim;
/** A fenced code block, with its language. */
const FENCE = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    // A brace pair that doesn't parse can still be a JSON dump cut short.
    return /^[{[]\s*"[^"\n]+"\s*:/.test(t);
  }
}

/** Drop blocks and lines that are JSON. With `allCode`, every fenced block goes. */
function dropJson(text: string, allCode: boolean): string {
  const unfenced = text.replace(FENCE, (block, lang: string, body: string) => {
    if (allCode || /^json[c5]?$/i.test(lang) || looksLikeJson(body)) return '';
    return block;
  });
  const lines = unfenced.split('\n');
  const kept: string[] = [];
  // A JSON object printed over several lines, outside a fence.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = line.trim();
    if (start === '{' || start === '[' || /^[{[]\s*"/.test(start)) {
      let end = i;
      let candidate = line;
      while (!looksLikeJson(candidate) && end + 1 < lines.length && end - i < 200) candidate += `\n${lines[++end]}`;
      if (looksLikeJson(candidate)) { i = end; continue; }
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').replace(/\(\s*\)/g, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function strip(text: string, allCode: boolean): string {
  return tidy(
    dropJson(text, allCode)
      .replace(ROUTING_TAG, '')
      .replace(TASK_MARKER, '')
      .replace(REPLY_LINE, '')
      .replace(TOOL_NAME, '')
      .replace(TASK_ID, '')
      .replace(BARE_ID, ''),
  );
}

/**
 * The Dispatcher's own reply as the chat shows it: no routing tags, task ids,
 * reply instructions, tool names or JSON. Other code blocks stay, since the
 * person may have asked for one.
 */
export function cleanChatText(text: string): string {
  return strip(text, false);
}

/**
 * News on its way to the Dispatcher's chat: as cleanChatText, and every code
 * block goes too. A brief piece of news never needs one.
 */
export function cleanAgentNews(text: string): string {
  return strip(text, true);
}
