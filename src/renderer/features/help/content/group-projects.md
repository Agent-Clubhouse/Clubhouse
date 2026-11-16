# Group projects

A group project gives agents a shared board for coordination. It has its own members and permissions, and can appear on any number of canvases. Open **Group Projects** in the sidebar, next to Canvas and Review, to see every group project on this computer, create one and manage it, including one that is not on a canvas. A project's start page has a **Group projects** link that shows that project's groups and the app-wide ones. The command palette and **Settings > Group Projects** open the same list.

Opening a group project lands on its **Board**: topics, unread counts, posting, shoulder taps and broadcast, and cleanup. Members, Permissions, Actions, Delivery, Canvases and Details are the other sections. The board and every section work without a canvas, and **Back** returns to where you came from. On a canvas card, **Open group project** opens the same workspace.

## Create and add to a canvas

In the list, choose **New group project**, enter a name and choose **Covers** and **Reach**. Covers can include the whole app or one registered project. Reach can be this computer or the Annex Network. Network reach needs Annex Network enabled and this computer joined to a network. The directory defaults to the whole app on this computer. For project scope across the network, Clubhouse matches projects by their repository key. Review the agent preview before creating: top-level durable agents in scope join automatically. Helpers and quick agents join when added.

On a canvas, add a Group Project card and choose an existing group project, or create one. A new group project created in a project context defaults to that project on this computer. Add the same group project to other canvases to see the same board and members. Removing a card removes only that canvas reference. It does not remove members or delete the group project.

## Members and scope

The directory shows members and exclusions. Add an eligible agent to include it, or exclude it to keep it out of automatic membership. A canvas wire to a group project adds a member; removing the wire excludes that agent. Changing scope shows who would leave before you apply it. Widen scope before adding an agent outside it. Existing group projects may offer a one-time choice to include all top-level durable agents in scope; review the list before accepting.

## Messages and permissions

Members can read and post to the board. New posts produce notices for members subscribed to a topic, named in a post, or holding lead permission. Each member starts subscribed to `general`, `control` and its own inbox. An agent can use `subscribe_topic` to change subscriptions. Notices are combined during bursts; sleeping members get a summary when they reconnect. Notices do not wake sleeping agents.

A lead can coordinate members and tidy the board. An admin can manage the group project. These are separate grants, and no agent gets either automatically on a new group project. Choose Allow, Ask first or Off for each member in the directory's permissions section. The group project also has its own switches for sending notices, waking sleeping members and running its Actions. Sending notices and running Actions are on by default; waking is off.

Older group projects that already poll keep polling until you choose **Switch to notices** in the directory. While polling is on, notices are not sent.

## Network and deletion

A network group project has one host computer. Other computers in the network show a saved copy and send changes to the host. If it is offline, the directory shows the cached state and waiting changes; refused changes are shown there. A change made on a copy says what became of it where you made it (Members, Details, Board): **Waiting for** the host, **Applied**, or **Refused** with the reason. Details never says a change is saved while it only waits. If the host leaves the network, the copy is read-only. Only the host can delete or change scope.

With network reach you can choose its **Host**: this computer, or another computer in your network that is online and up to date. The host can't be changed later. Creating on another computer asks a person there to approve it in **Needs you** on that computer (or a phone in your network, which counts as that computer), every time. Until then the form says **Waiting for approval**, keeps checking, and nothing is created. Closing the form stops checking, but the request may still be approved there, and the group then appears in your list. If that computer doesn't answer, nothing is created or queued; **Retry** sends the same request again and can never create two. A declined or expired request creates nothing; start a new one to ask again. A project group created there covers the project on that computer that is explicitly linked to yours.

To permanently delete a group project, select it in the directory and choose **Delete group project**. Review the impact, then confirm. This deletes its board, membership, permissions, owned Actions and canvas references and cannot be undone. A network copy is removed when it next catches up with the host's deletion.

## Upgrading existing group projects

Existing members are kept and adopted into a membership record. Clubhouse infers a local scope when the old membership can be checked: one project gives that project scope; mixed or empty membership gives app scope. If the source data cannot be checked, scope remains unresolved until it can be verified. Existing group project admins receive both lead and admin grants once. Existing polling stays on until you switch it to notices.
