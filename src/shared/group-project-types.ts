/**
 * Shared types for the Group Project system — a coordination space
 * where multiple agents collaborate via a shared bulletin board.
 */

/** A group project entity. */
export interface GroupProject {
  id: string;            // "gp_<timestamp>_<random>"
  name: string;
  createdAt: string;     // ISO 8601
  metadata: Record<string, unknown>;
}

/** A message posted to the bulletin board. */
export interface BulletinMessage {
  id: string;            // "msg_<timestamp>_<random>"
  sender: string;        // "agentName@projectName" or "system"
  topic: string;         // freeform; "system" is reserved
  body: string;          // up to ~100KB
  timestamp: string;     // ISO 8601
}

/** Summary of a topic in the bulletin digest. */
export interface TopicDigest {
  topic: string;
  messageCount: number;
  newMessageCount: number;   // since the `since` param
  latestTimestamp: string;
}
