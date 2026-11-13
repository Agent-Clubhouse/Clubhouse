# Group projects

A group project gives agents a shared board for coordination. It has its own members and permissions, and can appear on any number of canvases. Open **Settings > Group Projects** or choose Group Projects in the command palette to create and manage one, including one that is not on a canvas.

## Create and add to a canvas

In the directory, enter a name and choose **Covers** and **Reach**. Covers can include the whole app or one registered project. Reach can be this computer or the Annex Network. Network reach needs Annex Network enabled and this computer joined to a network. The directory defaults to the whole app on this computer. Review the agent preview before creating: top-level durable agents in scope join automatically. Helpers and quick agents join when added.

On a canvas, add a Group Project card and choose an existing group project, or create one. A new group project created in a project context defaults to that project on this computer. Add the same group project to other canvases to see the same board and members. Removing a card removes only that canvas reference. It does not remove members or delete the group project.

## Members and scope

The directory shows members and exclusions. Add an eligible agent to include it, or exclude it to keep it out of automatic membership. A canvas wire to a group project adds a member; removing the wire excludes that agent. Changing scope shows who would leave before you apply it. Widen scope before adding an agent outside it. Existing group projects may offer a one-time choice to include all top-level durable agents in scope; review the list before accepting.

## Messages and permissions

Members can read and post to the board. New posts produce notices for members subscribed to a topic, named in a post, or holding lead permission. Each member starts subscribed to `general`, `control` and its own inbox. An agent can use `subscribe_topic` to change subscriptions. Notices are combined during bursts; sleeping members get a summary when they reconnect. Notices do not wake sleeping agents.

A lead can coordinate members and tidy the board. An admin can manage the group project. These are separate grants, and no agent gets either automatically on a new group project. Choose Allow, Ask first or Off for each member in the directory's permissions section. The group project also has its own switches for sending notices and allowing a lead's tap to wake a sleeping member. Sending notices is on by default; waking is off.

Older group projects that already poll keep polling until you choose **Switch to notices** in the directory. While polling is on, notices are not sent.

## Network and deletion

A network group project has one host computer. Other computers in the network show a saved copy and send changes to the host. If it is offline, the directory shows the cached state and waiting changes; refused changes are shown there. If the host leaves the network, the copy is read-only. Only the host can delete or change scope.

To permanently delete a group project, select it in the directory and choose **Delete group project**. Review the impact, then confirm. This deletes its board, membership and canvas references and cannot be undone. A network copy is removed when it next catches up with the host's deletion.

## Upgrading existing group projects

Existing members are kept and adopted into a membership record. Clubhouse infers a local scope when the old membership can be checked: one project gives that project scope; mixed or empty membership gives app scope. If the source data cannot be checked, scope remains unresolved until it can be verified. Existing group project admins receive both lead and admin grants once. Existing polling stays on until you switch it to notices.
