# Annex

Annex connects Clubhouse instances on the same local network, so one machine can watch and drive the agents on another. The machine being controlled is the **satellite**. The one doing the controlling is the **controller**. The Annex iOS app pairs the same way a controller does.

Open Settings with `⌘,` to find the two Annex pages: **Annex** for this machine as a satellite, and **Annex control** for this machine as a controller.

## Let another machine control this one

1. In Settings, pick **Annex** and turn on **Allow remote control**.
2. Set a **Device name**, and an **Alias** and **Color** under **Identity**, so the controller can tell machines apart.
3. Note the **Pairing PIN**. **Regenerate** gives you a new one.

The page also shows the server status and how many devices are connected.

## Control another machine

1. In Settings, pick **Annex control** and turn on **Connect to satellites**.
2. Click **Add satellite**. Satellites found on the network are listed. Click **Scan** to look again.
3. Click **Pair** on the satellite you want.
4. Enter the satellite's PIN and click **Pair**.

After pairing, the two machines reconnect on their own. No PIN is needed again.

## Switching hosts

Once a satellite is paired, a host row appears at the top of the sidebar. It shows which machine you're looking at. Click it to:

- switch between **Local** and each satellite, with its connection state;
- **Retry** a satellite that's offline;
- **Pair a satellite…**;
- open **Annex settings**.

When you switch to a satellite, the sidebar lists its projects and agents. You can type into its agents' CLI views, start quick agents, and wake or stop agents there.

Agents on any connected host that are waiting on you appear under **Needs you**, tagged with the host's name. Clicking one switches to that host and opens the agent. Permission prompts from a satellite's agents are answered on the controller.

## On the satellite

While a controller is connected, the satellite shows a lock screen naming the controller, and its own keyboard input is blocked. From there you can **Disconnect**, **Pause** to type locally for a while, or **Disconnect & disable Annex** to also turn off remote control. **Resume** hands control back after a pause.

## Security

- Everything stays on your local network. There's no cloud service in between.
- Each instance has its own key pair. After pairing, connections use mutual TLS, and each side checks the other's certificate.
- After 3 wrong PINs from one address, pairing slows down. After 6, it locks for 5 minutes.
- **Reset Annex** on the Annex page, and **Forget all satellites** on the Annex control page, drop all pairings, so every device has to pair again.

## If something goes wrong

| Problem | Try |
|---------|-----|
| Satellite not found | Check both machines are on the same network and remote control is on. Click **Scan**. A firewall can block discovery. |
| Connection keeps dropping | Check the network between the machines. The controller retries on its own. |
| Pairing locked | Wait 5 minutes and try again. |
