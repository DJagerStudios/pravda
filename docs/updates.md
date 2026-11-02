# Updates

The Pravda desktop app keeps itself up to date from this repository's
[GitHub releases](https://github.com/DJagerStudios/pravda/releases).

## When it checks

- **When Pravda starts.** The opening animation waits a few seconds for the
  check. If there is an update, the animation shows the download, then Pravda
  installs it and starts again as the new version. If the download takes a
  while, *Continue without updating* appears; the download then carries on in
  the background.
- **Every six hours while it runs.** A newer version is downloaded in the
  background. A notice then offers *Restart now*. Pravda never restarts by
  itself while it is running, so a call is never cut short.
- **Whenever you ask.** Settings, Desktop app, *Check for updates*, or
  *Check for updates…* in the app menu.

The check asks GitHub for the list of releases. It sends nothing about you,
your servers or your messages.

## How an update is checked

Each release carries `Pravda-<version>-update.json`. This manifest lists every
download with its size and SHA-256 checksum. It comes with
`Pravda-<version>-update.json.sig`, an Ed25519 signature made with Pravda's
release key. The app carries the matching public key (`desktop/release-key.pem`).
An update installs only when:

1. the signature over the manifest checks out against that key;
2. the manifest's version matches the release and is newer than the one running;
3. the downloaded file matches the size and SHA-256 in the signed manifest.

Anything else is refused and reported. Neither a tampered download nor a
release signed with another key can install.

## How it is installed

| Your copy | What happens |
|---|---|
| Linux AppImage | The AppImage file is replaced in one step and starts again |
| Linux `.tar.gz` folder | The new version is unpacked beside the old; once Pravda has quit, the folders are swapped and the new one starts |
| Windows `.zip` folder | The same, done by a small PowerShell helper |
| macOS `Pravda.app` | The same: the app bundle is swapped once Pravda has quit |
| Linux `.deb` | Your package manager owns the files, so Pravda offers the new `.deb` on the release page instead |
| A folder Pravda cannot write to | The same: a link to the release page |

If a new version fails to start, Pravda notices on the next start and says
so. It waits a day before trying that version again by itself.

## Settings

Settings, Desktop app:

- **Install updates automatically** (on by default). When it is off, Pravda
  still checks, then offers *Update*, *Later* or *Skip this version*.
- **Include beta versions** (off by default). Betas are published as GitHub
  pre-releases, such as `v0.4.0-beta.1`, and only copies with this switched on
  move to them.

Copies run from the source code (`electron desktop`) never update themselves.
Setting `PRAVDA_NO_UPDATES=1` turns updates off for a packaged copy too.

## For maintainers

Pushing a tag such as `v0.3.1` runs `.github/workflows/release.yml`. It
builds every download and signs the manifest with the `PRAVDA_SIGNING_KEY`
secret. It then publishes the release with the notes in
`docs/releases/<version>.md`. A tag with a hyphen becomes a pre-release.
[CONTRIBUTING.md](../CONTRIBUTING.md) covers the signing key and a release
from start to finish.
