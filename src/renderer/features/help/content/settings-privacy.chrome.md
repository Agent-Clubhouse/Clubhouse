# Privacy and diagnostics

Clubhouse keeps a record of what happens in the app on this computer. Nothing from it leaves your computer unless you turn on a destination. Feedback reports go to the developer only when you send one.

## What stays on this computer

| Record | Leaves this computer? |
|--------|-----------------------|
| The diagnostic log | Never |
| Local telemetry, the app's own events | Only to a destination you turn on |
| Settings changes | Recorded as which area changed, never the value |
| Agent conversations and your files | Never, as part of telemetry |

The record lives in `~/.clubhouse/logs`. **Settings > Logging** opens that folder, and **Record locally** turns the record off. While it's off, nothing is written and there's nothing for export to send.

**Retention** sets how much is kept.

| Retention | Keeps |
|-----------|-------|
| **Low** | 3 days, up to 50 MB |
| **Medium** | 7 days, up to 200 MB |
| **High** | 30 days, up to 500 MB |
| **Unlimited** | No limit on age or size |

Diagnostic log lines keep file paths, error messages and session ids as written. They aren't anonymized, which is why Clubhouse never sends them. **Minimum level** and **Namespaces** decide which lines are written. See [Logging and diagnostics](#help:settings-logging) for the details.

## Exporting telemetry

**Telemetry export**, at the bottom of **Settings > Logging**, sends anonymized telemetry to your own Azure Application Insights, an OpenTelemetry backend, or both. Every destination is off until you set it up and turn it on.

- **Learn what's sent** lists what export sends and what it never sends.
- **Preview data** shows records as they would leave.
- Each destination has its own **Level** and **What to send**.
- **Send test event** checks a destination.

When you turn on a destination and Clubhouse has kept telemetry from before, it offers to send that history too. Pick how far back, then **Send** or **Not now**. Diagnostic log lines are never part of it.

Under **Advanced**, **Reset telemetry ID** gives this install a new id, and **Delete local telemetry data** deletes what's kept and turns telemetry off, keeping your destination settings.

## Feedback reports

Once you've connected in **Settings > Feedback** with an invitation, a **Feedback** button shows in the sidebar. `⌘⇧2` opens it with what's under the pointer.

A report holds your note, a screenshot of the Clubhouse window you choose, and, if you tick **Include recent diagnostics**, connection, agent and chat events from the last 30 minutes, with no messages, paths or chat content. You can read those lines before you send. Links, email addresses and file paths in your note are removed before sending. **Send without screenshot** leaves the picture out.

While you have a note or drawing, pressing Esc or clicking outside the dialog doesn't close it, so you don't lose it by accident.

A sent report is saved on this computer first, then sent as soon as Clubhouse can reach the server. If your access has expired, the report stays saved. Connect again with a new invitation in **Settings > Feedback**, then send it from **Held reports** there.

## Telemetry for the developer

After you connect Feedback, Clubhouse asks whether to share user activity and errors with the developer as well. Nothing is shared unless you choose **Share**. Change it later with **Send telemetry** under **Telemetry for the developer** in **Settings > Feedback**.

See also [Logging and diagnostics](#help:settings-logging)
