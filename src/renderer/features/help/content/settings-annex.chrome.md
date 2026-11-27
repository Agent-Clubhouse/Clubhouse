# Annex Network

Annex Network joins your computers and your phone into one network. Every computer sees every computer's projects and agents in one sidebar, and you can chat with, connect and approve agents on any of them. Pair a new device with any device in the network and it joins all of them.

Everything is in **Settings > Annex Network**. Turn on **Annex Network on this computer** to take part. While it's off, this computer neither answers nor connects to other devices.

## This computer

**This computer** shows how other devices see this one. **Device name** is how it appears to your other computers and the phone. It also shows the addresses it can be reached at, its **Annex port** and its **Certificate code**.

**Only accept connections from this computer** makes Annex listen on this computer alone and turns discovery off. Use it when you reach this computer through your own forward or SSH.

## Adding a device

Click **Add a device**, then **Pair with another computer**. There are three ways to pair, and each one needs a person at the new device to finish.

| Way | Use it when |
|-----|-------------|
| **Discovered on this network** | Both computers are on the same network. Pick the computer, check that the certificate codes match, choose **Codes match**, then enter its one-time code. |
| **Paste pairing link** | You copied the other computer's **Pairing link**. With a forward, set an **Address override**. |
| **Pair without a link** | Discovery doesn't work, or you're on a VPN. Enter the **Address and port**, the full **Certificate fingerprint** and the **One-time code**, then **Pair manually**. |

The **One-time code** on the computer you're joining works once and changes every 10 minutes. **New code** makes another.

To add your phone, scan **Pair a phone** with Clubhouse Go or the iPhone Camera.

After pairing, devices reconnect on their own.

## Devices

**Devices** lists every device in the network with its state, such as **Connected**, **Offline** with when it was last seen, or **Needs pairing again**. **Scan** looks for computers on the network again.

- **Reconnect** tries again now.
- **Pair again** pairs a device whose pairing no longer works.
- **Rename** renames a computer everywhere in the network.
- **Remove**, then **Confirm**, takes a device out of every device in the network. Devices that are off hear about it when they next connect.

## In the sidebar

Once another computer is paired, **Show** at the top of the sidebar narrows it to **All computers**, **This computer** or one computer. Each computer shows whether it's connected, how many of its items wait on you, and **Reconnect** when it's not. **Annex Network settings** opens this page.

Projects on another computer are named with that computer, such as "api on studio-mac". In **Needs you**, an item from another computer says which one. Permission prompts from its agents are answered where you are.

## Linking projects

When the same repository is open on two of your computers, the sidebar suggests linking them, with **Link** or **Keep separate**. Linked projects show as one project, and pinning or marking one inactive applies to every copy. Manage links under **Linked projects** in the project's settings, with **Link**, **Unlink** and **Link with another project**.

## When a computer goes offline

Its projects and agents stay in the sidebar, dimmed and marked offline. Their chats stay readable. Messages and files sent to its agents wait and go in order when it's back. Other calls to it are refused until then.

## Dispatchers and handoffs

Each computer's Dispatcher shows in the sidebar, and **Settings > Dispatcher** can make one of them lead for the whole network. See [Dispatcher](#help:agents-dispatcher).

**Accept handoffs from other computers** is on by default. It lets agents on other computers in your network offer work here. Handoff permissions, and the receiver's agreement, still apply. See [Handoffs](#help:agents-handoffs).

## One-to-one pairings and phones

A computer or phone paired one-to-one, rather than as part of the network, can control this computer. While it does, this computer shows a lock screen that names it, and blocks its own keyboard. **Pause** lets you type here for a while and **Resume** hands control back. **Disconnect** ends it, and **Disconnect & Disable Annex** also turns Annex Network off here. Computers in your network don't lock each other.

## Each direction, and forwards

In **Settings > Annex Network**, each computer in your network says, in two short sentences under its name, whether this computer can reach it and whether it can reach this computer. Phones and one-to-one pairings don't show this. When only one works, the row says so and what to do next, such as "You can reach Studio, but it can't reach this computer."

- To give a computer that's already paired a new address to reach it at, such as a local forward, click **Address** on its row and save it. You don't need to pair again. Clubhouse checks the address shows that computer's certificate before saving it, and keeps the old address if it doesn't.
- Two computers that can reach each other only through forwards need one forward on each, and each saves its own address for the other.
- If it was paired again with a new certificate, an address saved before is kept but not used. Save it under **Address** to check it again.
- **Annex port** under **This computer** is the port a forward to this computer must reach. If another program had that port when Clubhouse started, it says which port Annex uses instead. The other program is left alone.

## Security

- There's no cloud service in between. Devices connect to each other directly, on your network or through addresses and forwards you set up.
- Each device has its own key pair. After pairing, connections use mutual TLS, and each side checks the other's certificate.
- After 3 wrong codes from one address, pairing slows down. After 6, that address is locked out for 5 minutes. After 10 wrong codes from any addresses, pairing pauses for everyone until you choose **Allow pairing again**.
- While **Rich chat content** is on in **Settings > Agents & CLIs**, paired phones can read any file your user account can read on this computer, up to a size limit, with no prompt for each file. Turn it off to stop that.
- **Reset Annex Network**, under **Reset**, stops Annex and deletes this computer's identity, certificate and every pairing, so every device has to pair again.

## If something goes wrong

| Problem | Try |
|---------|-----|
| A computer isn't found | Check both computers are on the same network and Annex Network is on there. Click **Scan**. A firewall can block discovery. Or pair without a link. |
| A connection keeps dropping | Check the network between the computers. They reconnect on their own, and **Reconnect** tries again now. |
| Pairing is locked or paused | Wait 5 minutes and try again, or choose **Allow pairing again**. |
