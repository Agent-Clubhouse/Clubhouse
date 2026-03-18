# Annex V2 — Desktop Remote Control

Annex V2 enables **desktop-to-desktop remote control** between Clubhouse instances on the same local network. One instance acts as a **satellite** (being controlled) while another acts as a **controller** (sending commands).

## Overview

- **Satellite**: The Clubhouse instance whose agents are being controlled remotely. Enable the Annex Server in Settings.
- **Controller**: The Clubhouse instance issuing commands. Use the Annex Control settings page to pair and manage satellites.
- **Security**: All communication uses mutual TLS (mTLS) with self-signed certificates. Identity is based on Ed25519 keypairs.

## Setup

### On the Satellite (Instance A)
1. Go to **Settings > Annex Server**
2. Toggle **Enable Annex server** on
3. Set a recognizable **Alias** and **Color** for identification
4. Note the **Pairing PIN** — you'll need this on the controller

### On the Controller (Instance B)
1. Go to **Settings > Annex Control**
2. Click **Add Satellite** (or the satellite will appear via Bonjour discovery)
3. Enter the satellite's **PIN** when prompted
4. Both instances exchange cryptographic keys automatically

## Pairing

Pairing establishes a trusted relationship between two instances:

1. The controller queries the satellite's identity endpoint
2. The controller sends the PIN + its public key to the satellite
3. The satellite validates the PIN and returns its public key
4. Both sides store each other's keys for future mTLS connections
5. A bearer token is issued for the initial session

After pairing, connections use **mutual TLS** — no PIN required for reconnection.

### Brute-force Protection
- 3 free PIN attempts per source IP
- Exponential delay after 3 failures (5s, 15s, 45s)
- Full lockout after 6 failed attempts (5-minute cooldown)
- Manual unlock available in Settings > Annex Server

## Usage

### Viewing Remote Agents
- Paired satellites appear in the **Project Rail** under a divider with the satellite's alias and color
- Click a remote project to see its agents in the Agent List
- Terminal output streams in real-time over WebSocket

### Controlling Agents
- Type in a remote agent's terminal — input is forwarded to the satellite
- Spawn quick agents on the satellite from the controller
- Wake sleeping durable agents remotely
- Kill running agents remotely

### Permission Handling
When a remote agent requests permission (e.g., file write, bash command), the permission prompt appears on the **controller** — not the satellite. The controller user approves or denies, and the decision is forwarded back.

## Satellite Locking

When a controller connects to a satellite:

- The satellite shows a **full-screen lock overlay** with the controller's identity
- Local keyboard input is blocked to prevent conflicts
- The satellite user has three options:
  - **Disconnect**: Close the controller's connection
  - **Pause**: Temporarily re-enable local input (controller stays connected)
  - **Disconnect & Disable**: Close the connection and turn off the Annex server

## Security Model

- **Ed25519 Identity**: Each instance has a unique keypair, generated on first Annex enable
- **ECDSA P-256 TLS**: Self-signed certificates for mTLS transport (CN = Ed25519 fingerprint)
- **Dual-port Architecture**: Pairing uses plain HTTP; all authenticated traffic uses TLS with mutual certificates
- **No Private Key Exposure**: The identity endpoint only returns the public key and fingerprint
- **LAN-only**: Bonjour/mDNS discovery is limited to the local network
- **No cloud dependency**: All communication is peer-to-peer on the LAN

## Troubleshooting

### Satellite not discovered
- Ensure both machines are on the same local network
- Check that the satellite's Annex server is enabled and advertising
- Try clicking **Scan** in the Annex Control settings
- Bonjour/mDNS may be blocked by firewall rules

### Connection drops frequently
- Check network stability between the two machines
- The heartbeat mechanism pings every 30 seconds; connections are dropped after 10 seconds without a pong
- Auto-reconnect is enabled by default — the controller will retry with exponential backoff

### Pairing locked out
- After 6 failed PIN attempts, pairing is locked for 5 minutes
- To unlock immediately: Settings > Annex Server > Unlock Pairing
- Or wait for the 5-minute cooldown to expire

### Cannot control agents (permission denied)
- Control messages (PTY input, agent spawn/kill) require mTLS authentication
- Ensure you paired properly (exchanged public keys during pairing)
- Bearer-token-only connections (e.g., from older iOS clients) cannot send control messages
