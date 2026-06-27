---
name: group-pm-polling
description: Set up a separate polling loop for the Group PM with message pruning and wake/sleep management
---

# Group PM Polling Skill

The Group PM polling skill establishes an independent polling loop for the Group Project PM, separate from routine mission-polling agents. This skill runs on a 10-30 minute cadence (typically 15m) to:

- Monitor all channels on the group project board for coordination updates
- Manage agent wake/sleep state based on workload
- Prune stale messages to keep the board lean
- Handle context management and agent compaction when needed

## Polling Behavior

- **Cadence**: 10-30 minute window (default: 15 minutes)
- **Channels monitored**: `general`, `control`, all work channels, all agent inboxes
- **Scope**: Full board visibility (PM role requires this for coordination)
- **Action triggers**: Message pruning, agent wake/sleep signals, context bloat detection

## Key Responsibilities

1. **Board monitoring** — read bulletin with `summary=true` to get digest before drilling into specific channels
2. **Channel hygiene** — use `clear_topic` to retire completed channels and `delete_messages` to remove stale content
3. **Agent lifecycle** — coordinate wake/sleep with polling state; stop polling before sleeping agents
4. **Context management** — use `compact_agent` when an agent's context grows too large
5. **Routine alerts** — post status summaries periodically to keep team aligned

## Usage

This skill is automatically invoked as part of the Group PM persona's skill bundle. It runs independently of agent mission assignments and does not require explicit invocation.

When applied to an agent, the skill configures:
- A persistent `/loop` on the configured cadence
- Access to all channels for digest and targeted reads
- Automated pruning triggers based on message count thresholds

## Integration

The Group PM polling skill integrates with:
- `read_bulletin` — efficient digest reads with timestamp filtering
- `read_topic` — drill-down into channels with new activity
- Board management tools — `clear_topic`, `delete_messages`, `compact_agent`, `clear_agent`
- Agent lifecycle tools — `wake_agent`, `sleep_agent`, `start_polling`, `stop_polling`
