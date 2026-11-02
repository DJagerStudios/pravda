# The Pravda desktop app

The desktop app is the Pravda client in its own window, built on Electron.
It carries its own copy of the web client rather than loading one from the
server, so a server cannot change the code that does your encryption. It adds:

- **updates that install themselves**, checked against Pravda's signing key
  ([updates.md](updates.md));
- sign-in tokens kept in your operating system's keychain;
- **Ctrl+Shift+M** (mute) and **Ctrl+Shift+D** (deafen), working from any
  application (on macOS, Cmd instead of Ctrl);
- a tray icon that shows unread mentions; closing the window keeps Pravda
  running so calls and notifications continue (quit from the tray or with
  Ctrl+Q);
- unread mentions on the taskbar or dock, and a flash when you are mentioned
  while Pravda is in the background;
- a remembered window size and position, and opening at login;
- a picker for sharing a screen or a single window;
- **Start hosting**, which runs a Pravda server on your computer for friends
  on your network;
- trust for a home server's self-signed certificate, checked by fingerprint.

To use a different server, choose **Switch server** from the menu under your
name, or from the app menu (press Alt to show it on Linux and Windows).

## Installing

Downloads are on the [releases page](https://github.com/DJagerStudios/pravda/releases/latest).

### Linux

- **AppImage** (`Pravda-<version>-linux-x86_64.AppImage`, or `-aarch64`): make
  it executable and run it: `chmod +x Pravda-*.AppImage && ./Pravda-*.AppImage`.
  It updates itself in place.
- **Debian and Ubuntu** (`Pravda-<version>-linux-amd64.deb`, or `-arm64`):
  `sudo apt install ./Pravda-*.deb`. It installs into `/opt/Pravda` and adds
  Pravda to your menu. A new version is installed the same way; Pravda shows a
  link when one is out.
- **tar.gz** (`Pravda-<version>-linux-x86_64.tar.gz`): unpack it anywhere you
  can write to and run `./pravda`. `./install.sh` adds Pravda to your
  application menu. It updates itself in place.

Screen sharing on Wayland goes through your desktop's own screen-sharing
dialog (xdg-desktop-portal with PipeWire).

### Windows

Extract `Pravda-<version>-windows-x64.zip` (or `-arm64`) anywhere you can
write to, such as your user folder, and run `Pravda.exe`. The build is not
code-signed, so SmartScreen may warn on first start: choose *More info*, then
*Run anyway*. It updates itself in place.

### macOS

macOS 13 (Ventura) or later. Unzip `Pravda-<version>-macos-arm64.zip` (Apple
Silicon) or `-macos-x64.zip` (Intel) and move `Pravda.app` to Applications.
The build is not signed or notarised, so macOS refuses to open it at first.
Run this once in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Pravda.app
```

The first call asks for microphone and camera permission, and the first
screen share for screen recording permission (System Settings → Privacy &
Security). It updates itself in place.

## Settings, Desktop app

- **Open Pravda when you log in**, and **Start in the tray**: it then waits
  in the tray until you need it.
- **Keep running in the tray when the window closes** (on by default).
- **Install updates automatically** (on by default), **Include beta
  versions**, and **Check for updates**, with the version you are running.

## Where it keeps things

| | Linux | Windows | macOS |
| --- | --- | --- | --- |
| Settings, servers, pinned certificates | `~/.config/Pravda` | `%APPDATA%\Pravda` | `~/Library/Application Support/Pravda` |
| A server you host | `…/Pravda/server` | `…\Pravda\server` | `…/Pravda/server` |
| That server's log | `…/Pravda/server.log` | `…\Pravda\server.log` | `…/Pravda/server.log` |
| Downloaded updates, until installed | `…/Pravda/updates` | `…\Pravda\updates` | `…/Pravda/updates` |

Setting `PRAVDA_USER_DATA=/some/folder` runs the app with a separate profile,
for example a portable copy on a USB stick. `PRAVDA_NO_UPDATES=1` turns
updates off.

## Hosting from the app

**Start hosting** runs the bundled server with a self-signed certificate. It
listens on port 8347 (TCP) for the web and the gateway, and on port 8348 (UDP
and TCP) for voice and video. The page then shows:

- the addresses friends on your network connect to;
- the certificate fingerprint their app will ask them to check;
- the firewall ports to open.

The server stops when you quit Pravda. Its data stays in the folder above, so
starting it again brings everything back. To reach friends over the
internet, run a server as described in [HOSTING.md](HOSTING.md).

## Building

```sh
python3 -I packaging/build.py --targets linux-x86_64,windows-x64,macos-arm64
```

To run the app from the repository while developing, use a recent Electron
(it is tested with 43 and 44): `electron desktop --dev`. The `--dev` flag adds
the developer tools to the View menu.
