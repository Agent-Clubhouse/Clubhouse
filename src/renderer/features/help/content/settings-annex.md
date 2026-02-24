# Annex (iOS Companion)

Annex lets you monitor and interact with your agents from an iOS device on the same local network.

## Setup

1. Open **Settings > Annex**
2. Toggle the local server **on**
3. A 6-digit PIN is displayed
4. On your iOS device, open the Annex app and enter the PIN to pair

Devices are discovered automatically via Bonjour/mDNS on your local network.

## What You Can Do from iOS

- See agent status in real time (working, idle, error, needs permission)
- **Approve or deny** permission requests remotely
- View tool call details and agent activity

> **Example:** Step away from your desk and approve a permission request from your phone when an agent is waiting.

## Settings

| Setting | Description |
|---------|-------------|
| **Server toggle** | Enable/disable the local Annex server |
| **Status & port** | Shows whether the server is running and on which port |
| **Connected devices** | Count of currently paired devices |
| **PIN** | Display and regenerate the pairing PIN |
| **Device name** | Custom name shown to iOS clients |

## Security

- All communication stays on your **local network** — nothing goes to external servers
- PIN pairing prevents unauthorized device access
- Regenerate the PIN anytime to revoke existing pairings
