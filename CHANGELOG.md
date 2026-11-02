# Changelog

All notable changes to Pravda. Versions follow [semantic versioning](https://semver.org/).

## 0.3.0 — 2026-11-02

The first public release, on GitHub, with desktop downloads for every system
that keep themselves up to date.

### Added

- Desktop downloads for Windows (x64, ARM64), macOS (Apple Silicon, Intel) and Linux (x86_64, aarch64): `.zip`, `.AppImage`, `.deb` and `.tar.gz`, plus the server on its own for each system.
- Self-updating desktop app: checks at start and every six hours, verifies each release's manifest against Pravda's Ed25519 release key and each download's SHA-256, installs, and starts again. It can be switched off, and beta versions can be opted into.
- Quick switcher (Ctrl+K), a keyboard shortcuts sheet (Ctrl+/), Alt+↑/↓ between channels and Alt+Shift+↑/↓ to the next channel with something new, Escape to mark a channel read and Shift+Escape for a whole server.
- A "New messages" rule where unread begins, with a banner to jump to it or mark everything read.
- Notification levels and muting per server, channel and conversation, from a right-click menu; muted channels recede and stay quiet.
- "Mark as read" for servers and channels, "Copy text" on messages, and "Mute for me" for people in calls.
- Accessibility settings: contrast (system, standard, high), the Atkinson Hyperlegible readable font, text up to 150%, role colours on or off, always-visible message times, reduced motion, and screen reader announcements of new messages.
- Keyboard navigation through messages, skip links, screen reader names for every badge and status, menus driven by the arrow keys, and support for Windows high-contrast mode.
- Desktop app: remembers its window, can open at login and start in the tray, shows unread mentions on the tray icon, the taskbar and the dock, and flashes for mentions while in the background.
- Continuous integration and releases built by GitHub Actions.

### Changed

- One cream, red and black palette for light and dark themes; the interface is in plain English, and only the graphics follow the poster style.
- The opening animation is a centred sunburst and stays up while the desktop app updates itself.
- Release files are named `Pravda-<version>-<system>-<arch>`.

### Fixed

- The opening animation could stay up forever when the server answered very quickly, or in a window that receives no animation frames.
- Desktop windows on Wayland never appeared while waiting for their first frame.
- Electron's archives carried world-writable file modes into the packages.
- The YouTube player kept seeking when it never reported its position.

## 0.2.0 (not published)

- The development version before the first public release: end-to-end encryption for messages, files, reactions, names and calls; a mandatory authenticator app; recovery key and codes; disappearing messages; entry gates; watch together; and the desktop app with hosting and certificate trust.
