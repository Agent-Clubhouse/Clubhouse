# Annex

Annex connects Clubhouse instances on the same local network, so one machine can watch and drive the agents on another. The machine being controlled is the **satellite**. The one doing the controlling is the **controller**. The Annex iOS app pairs the same way a controller does.

Annex is off until you turn it on. Open Settings to find the two Annex pages: **Annex** for this machine as a satellite, and **Annex control** for this machine as a controller.

## Let another machine or the iOS app control this one

1. Open **Settings > Annex** and turn on **Allow remote control**.
2. Set a **Device name**, and an **Alias** and **Color** under **Identity**, so the controller can tell machines apart.
3. Note the **Pairing PIN**. **Regenerate** gives you a new one.

The page also shows the server status and how many devices are connected.

## Control another machine

1. Open **Settings > Annex control** and turn on **Connect to satellites**.
2. Click **Add satellite**. Satellites found on the network are listed. Click **Scan** to look again.
3. Click **Pair** on the satellite you want.
4. Enter the satellite's PIN and click **Pair**.

After pairing, the two machines reconnect on their own. No PIN is needed again.

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
