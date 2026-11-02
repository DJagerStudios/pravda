# Design notes

## What was learned from Discord

Pravda aims to feel familiar to people who use Discord. The structure was
learned from Discord's public developer documentation and from using it, not
from its code: nothing was decompiled, and no Discord code, assets or
protocol implementation were copied. Concepts that carried over:

- **Servers ("guilds")** holding categories, text channels and voice
  channels, with a rail of server icons on the left, the channel list beside
  it, the conversation in the middle and members on the right.
- **Roles as permission bitfields**, ordered by position, with per-channel
  overwrites for a role or a single member that allow, deny or inherit. The
  owner and administrators bypass channel rules; a member can only act on
  someone ranked below them.
- **A realtime gateway** over WebSocket: a `hello` with a heartbeat interval,
  `identify`, a `ready` snapshot, numbered events, and `resume` to replay what
  a short disconnect missed.
- **Time-sortable IDs** (Discord calls them snowflakes), so pagination and
  read markers are integer comparisons.
- **Voice channels you drop into**, rather than calls you place, with
  speaking indicators, server mute and deafen, screen sharing you choose to
  watch, and a call bar that follows you around the app.
- **Invite links**, typing indicators, unread and mention badges, replies,
  reactions, pins, Markdown, a friends list and direct messages.

## Where Pravda differs

- **End-to-end encryption** for messages, files, reactions, names and calls.
  This shaped much of the design: search runs on the client; mentions are
  declared by the client so notifications still work; keys move between
  members' devices, sealed by the server's description of who may see what;
  invite links carry the server key in their fragment.
- **Self-hosted**: one binary and one SQLite file. No accounts with a
  company, no telemetry.
- **An authenticator app is required**, with recovery codes and a recovery
  key, because an encrypted account is only as safe as its sign-in.
- **Entry gates**: a server can require a password, or a code that rotates
  every few minutes, as well as an invite link.
- **Disappearing messages** on any channel or conversation.
- **Watching together** is built in rather than an add-on.
- **A desktop app that carries its own client**, so a server cannot alter the
  code that does the encryption.

## Visual design

The look takes its graphic style, and only its graphic style, from Soviet
and Chinese propaganda posters: flat colour, hard edges, heavy rules, bold
condensed capitals and rays bursting from a sun. The language of the
interface is plain English; Cyrillic appears only in the ПРАВДА title on the
poster and the opening animation.

### Three inks

Everything is printed in three inks, as a poster would be:

| Ink | Value | Used for |
| --- | --- | --- |
| Newsprint cream | `#efe6d2` | The page in light mode; type in dark mode |
| Banner red | `#c8102e` | Action, live, attention: primary buttons, mentions, the speaking outline, unread markers |
| Printer's black | `#15120f` | Type and rules in light mode; the page in dark mode |

Tints of each ink fill out the scales (`--paper-0…8`, `--ink-0…7`,
`--red-400…700` in `pravda.css`). Both themes draw only from those scales:

- **Light** is black ink on cream. Red type uses the deeper `#a90d26` to keep
  4.5:1 contrast on cream.
- **Dark** is cream type on black stock. Red type uses the lighter `#f04a62`
  for the same reason.

The artwork (poster, opening animation, logo, the call stage) uses the brand
inks directly and looks the same in both themes. Colours chosen by people,
such as role colours, are adjusted on screen until they read at 4.5:1 on the
current theme. Presence is shown by shape as well as colour (solid, half
filled, red, hollow), so it never depends on telling colours apart.

**High contrast** (chosen in settings, or following the system's "increase
contrast") makes secondary text full strength, turns every soft rule into a
solid one and thickens focus rings, in both themes. In Windows' forced-colours
mode the interface takes the system's colours, while the artwork keeps its
inks.

### Type

- **Russo One** for display titles (and the Cyrillic poster title).
- **Oswald** for labels, buttons and headings, in condensed capitals.
- **IBM Plex Sans** for reading, and **IBM Plex Mono** for code and numbers.

The **readable font** option replaces all three with **Atkinson
Hyperlegible**, designed by the Braille Institute for low vision, and sets
labels in sentence case instead of capitals. Only the poster's lettering
keeps its face.

All are bundled under the SIL Open Font License; nothing loads from a
third-party font service.

### Shape

There are no rounded corners or soft shadows. Depth comes from offset blocks
of solid ink (`4px 4px 0`), as in a misregistered print. Every label wraps
rather than truncating, and an automated layout audit checks the interface
at desktop, laptop and phone sizes, and at 150% text with high contrast and
the readable font, for clipped text and overlapping controls.

### The poster and the opening animation

The sign-in poster has a cream ground, red rays fanning from a low dark-red
sun, a black star, a black band across the corner, and ПРАВДА cut diagonally
in black with a cream outline. The slogan "Comrades of all servers, unite!"
sits on its own black label, so the artwork can never clip it at any window
size. On narrow screens the poster becomes a banner, with the slogan on a
strip beneath it.

The opening animation turns a full sunburst slowly behind a red sun. The
black star is stamped onto the sun, and the title label rises beneath it.
It plays for at least 1.3 seconds and fades into the first screen. The
*Reduce motion* setting, or the system's reduced-motion preference, turns it
off.
