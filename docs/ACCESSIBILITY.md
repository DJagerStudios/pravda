# Accessibility

Pravda should work for everyone: from the keyboard, with a screen reader, at
large text sizes, with low vision or colour blindness, and without motion.
If something gets in your way, please open an issue.

## Settings

**Settings, Accessibility:**

- **Contrast**: *System* follows your operating system's "increase
  contrast" setting; *High* makes secondary text full strength, turns every
  rule solid and thickens focus rings.
- **Text size**: 85% to 150%. Everything scales, and the layout keeps every
  word visible. An automated audit checks this at 150% for clipped or
  overlapping text.
- **Readable font**: [Atkinson Hyperlegible](https://www.brailleinstitute.org/freefont/),
  designed by the Braille Institute for people with low vision, everywhere,
  with labels in sentence case instead of capitals.
- **Show role colours on names**: turn off to show every name in the normal
  text colour. Role colours are always adjusted to stay readable on the
  current theme.
- **Always show message times**: show the time beside every message, not only
  on hover.
- **Reduce motion**: skips the opening animation and other movement. Your
  system's reduced-motion setting does the same.
- **Read out new messages**: screen readers announce each new message in the
  open channel as it arrives.

**Settings, Appearance:** light, dark, or following your system, and a
compact layout.

## Designed in

- Text meets WCAG AA contrast (at least 4.5:1) in both themes. Red type uses
  a deeper red on cream and a lighter red on black for that reason.
- Nothing relies on colour alone. Presence differs in shape (solid, half,
  red, hollow), unread channels are bold as well as marked, and links are
  underlined.
- Every control has a name for screen readers. Mention badges are read as
  "3 mentions", unread and muted channels say so, and the current channel
  and settings page are announced as current.
- Dialogs keep focus inside and give it back when they close. Menus move with
  the arrow keys.
- Windows high-contrast mode and other forced colours are respected, while
  the artwork keeps its own colours.
- Skip links at the very start of the page jump to the messages, the message
  box or the channel list.

## Keyboard

On macOS, use ⌘ for Ctrl and ⌥ for Alt.

| Keys | What it does |
|---|---|
| Ctrl+K | Quick switcher: jump to any channel, conversation or server. Start with `#` for channels, `@` for people, `*` for servers |
| Alt+↑ / Alt+↓ | Previous or next channel |
| Alt+Shift+↑ / Alt+Shift+↓ | Previous or next channel with something new |
| Ctrl+F | Search this channel |
| Esc | Mark this channel as read (or close whatever is open) |
| Shift+Esc | Mark this server as read |
| ↑ in an empty message box | Edit your last message |
| Enter / Shift+Enter | Send / new line |
| ↑ / ↓ on a message | Move between messages; Home and End go to the ends; Tab reaches the message's actions; Esc returns to the message box |
| Ctrl+Shift+M | Mute or unmute (works in other apps too, in the desktop app) |
| Ctrl+Shift+D | Deafen or undeafen (works in other apps too, in the desktop app) |
| Ctrl+, | Settings |
| Ctrl+/ | List these shortcuts |

Right-clicking a server, channel or conversation opens its menu: mark as
read, notification level, mute. The menu is also reachable from the server
name at the top of the channel list.
