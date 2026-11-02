# Contributing to Pravda

Thank you for helping. Issues and pull requests are welcome: bugs, ideas,
accessibility problems, translations of the docs, anything.

Please report security problems privately (see [SECURITY.md](SECURITY.md)),
not in a public issue.

## Working on Pravda

You need Go 1.27 or newer. For the client and the tests you also need
[Deno](https://deno.com/) 2 and Chromium.

```sh
go build -o pravda ./cmd/pravda
PRAVDA_WEB_DIR=web/public ./pravda --listen 127.0.0.1:8347
```

`PRAVDA_WEB_DIR` serves the web client straight from disk, so a page reload
picks up changes; there is no build step. Open http://127.0.0.1:8347.

To run the desktop app from the repository, use any recent Electron:
`electron desktop --dev`.

## Checks

```sh
go vet ./... && gofmt -l cmd internal
go test -race ./internal/...
deno lint --no-config --rules-exclude=no-explicit-any,no-window web/public/js desktop e2e
deno run -A --no-lock e2e/run.ts ./pravda /tmp/shots
```

`e2e/run.ts` drives two real browsers with fake cameras and microphones
through everything Pravda does. That covers registration with authenticator
codes, encrypted messages, files, calls with video and screen sharing, watching
together, direct messages, the quick switcher, notification levels and the
accessibility settings. It also audits the layout at several sizes and checks
that the database holds no plaintext. CI runs the first three lines on every
push.

The desktop tests run in a private, invisible KWin session, so nothing
appears on your desktop (KDE Plasma's `kwin_wayland` is needed):

```sh
e2e/desktop-nested.sh /usr/bin/electron ./pravda /tmp/shots
PRAVDA_NESTED_SCRIPT=update.ts e2e/desktop-nested.sh <old.AppImage> <new-release-folder> /tmp/shots
```

The second tests the self-updater with two real AppImages. Build them with
`packaging/build.py --targets linux-x86_64`, the second time with
`--version 0.3.1 --force-version`.

## Style

- Plain English everywhere in the interface, short and specific. The
  propaganda-poster style is for the graphics only.
- Colours come from the tokens at the top of `web/public/css/pravda.css`;
  nothing hard-coded. Check both themes and high contrast.
- Every control needs a name a screen reader can read, and must work from the
  keyboard. Nothing may be clipped or overlap at 150% text; the e2e layout
  audit checks this.
- Comments explain why, not what.

## Making a release

Releases are built by GitHub Actions from a tag, and the desktop app updates
itself to them, so a release must be signed with Pravda's release key.

1. Bump the version in `internal/server/server.go` and `desktop/package.json`.
2. Add the changes to `CHANGELOG.md`.
3. Write the release notes in `docs/releases/<version>.md`, in the style of
   the earlier ones: a one-line title, highlights, smaller changes, fixes,
   upgrading notes, the install table and the checksums note.
4. Commit, tag and push:

   ```sh
   git tag v0.3.1
   git push origin main v0.3.1
   ```

`.github/workflows/release.yml` then builds every download, signs the update
manifest and publishes the release. A tag with a hyphen (`v0.4.0-beta.1`)
becomes a pre-release, which only reaches people who include beta versions.

### The release key

The update manifest is signed with an Ed25519 key. Its public half is
`desktop/release-key.pem`, built into every copy of the app. The private half
lives in the repository secret `PRAVDA_SIGNING_KEY` and with the maintainer,
never in the repository. A build without it still works, but installed copies
will not update to it.

If the key is ever lost, existing copies cannot update to anything signed
with a new key. People would have to download one release by hand. If the key
leaks, rotate it the same way, and say so in the release notes.
