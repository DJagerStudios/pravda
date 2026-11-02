# Pravda security model

Pravda is built so that the people running a server cannot read what you
write, see what you share or hear your calls. This page says exactly what
that covers, what a server can still learn, and where the limits are. If you
find a way around any of it, please report it (see the end).

## What is end-to-end encrypted

Everything below is encrypted on your device and decrypted only on the
devices of people allowed to see it. The server stores and relays ciphertext.

| Content | How |
| --- | --- |
| Messages and edits | AES-256-GCM with the channel key, signed with the author's ECDSA key |
| Reactions | AES-256-GCM with the channel key |
| Files and images | A fresh AES-256-GCM key per file, carried inside the encrypted message |
| Voice, video and screen sharing | Every media frame is encrypted with a per-call key before it leaves your device |
| Server, channel and role names, topics, the server icon | AES-256-GCM with the server key |
| Group conversation names | The group's own key |
| Watch-together choices (which video, play/pause, position) | The channel key |

Only standard browser cryptography (WebCrypto) is used: P-256 ECDH and
ECDSA, AES-256-GCM, HKDF-SHA-256 and PBKDF2-SHA-256. No custom ciphers.

## Keys

- **Your identity** is a P-256 key pair for signing and one for key agreement,
  generated on your device when you register. The private halves are stored
  as non-extractable WebCrypto keys in the device's browser storage.
- **Your password never leaves your device.** It is stretched with
  PBKDF2-SHA-256 (600,000 iterations) into 512 bits. Half becomes the
  *auth key* that the server checks (it stores only an Argon2id hash of it).
  The other half becomes the *wrap key*, which seals a backup of your private
  keys. The server keeps that sealed backup so you can sign in on a new device.
  Without your password the backup is useless.
- **Your recovery key**, shown once at registration, can unseal the same
  backup and reset your password if you forget it. Nobody else can do this
  for you: if you lose both the password and the recovery key, your old
  messages are gone for good.
- **Channel keys** come in numbered generations. Each generation is sealed
  separately for every member allowed to read the channel, using ECDH between
  the sharer's and recipient's identity keys and HKDF. When someone loses
  access (they leave, are kicked or banned, or a permission changes), the next
  message sent there starts a new generation that they do not receive, and
  live calls switch keys immediately.
- **Server keys** encrypt names and the icon. An invite link carries the
  server key in its `#fragment`, which browsers never send to any server.
- **Call keys** are derived from the channel key of the current generation,
  so everyone who can read a channel can join its calls, and nobody else can.

## Signing in

- An authenticator app (TOTP) is required for every account by default.
  Recovery codes cover a lost phone.
- Sessions are random 256-bit tokens. In a browser they live in an HttpOnly,
  SameSite=Strict cookie that page scripts cannot read. The desktop app keeps
  them in the operating system's keychain (see below).
- Login, registration, messaging, uploads and the server password gate are
  rate limited.

## What the server can still see

End-to-end encryption hides content, not everything. A server operator (or
anyone who takes over the server) can see:

- **Who is in which server and channel**, who talks to whom in direct
  messages, and when people are online.
- **When** messages are sent, **how big** they and their files are, and how
  many reactions they carry.
- **Who is mentioned, and what a reply answers.** Your client tells the
  server which people a message mentions so it can notify them, and which
  earlier message a reply points to. The text itself stays encrypted.
- **Who is speaking in a call.** Voice packets carry a standard audio-level
  header that drives the "speaking" outline. The audio itself is encrypted.
  Video resolution and frame timing are also visible, because the server must
  forward the right streams.
- **Profiles**: usernames, display names, avatars, banners, pronouns, bios and
  status lines are visible to the server and to everyone you share a server
  with. They are not end-to-end encrypted.
- **IP addresses** of everyone connecting, unless they use a VPN or Tor.
- **Watch-together**: the choice is encrypted, but the YouTube player or the
  site hosting a linked video sees your IP address when it loads. Pravda asks
  before loading either.

## Limits you should know about

These are real limitations, not small print.

1. **The browser client comes from the server.** When you use Pravda in a web
   browser, the server sends the JavaScript that does the encryption. A
   malicious operator could send a modified client that leaks your keys. The
   desktop app avoids this: it carries its own copy of the client and only
   talks to the server's API. If you do not trust the people running a
   server, use the desktop app.
2. **The server says who the members are.** Clients share channel keys with
   the members the server lists. A malicious server could add a hidden
   account or device to a channel and receive keys from then on. Defences:
   member lists are visible to everyone in the server, joins can be announced
   in a channel, and key changes are flagged. For the people who matter, compare **safety numbers**
   (profile → Safety number) in person or on a call. If they match, nobody is
   in the middle.
3. **Trust on first use.** The first key your client sees for a person is
   pinned. If it later changes, Pravda shows a warning until you confirm it.
   It cannot tell whether that first key was genuine; safety numbers can.
4. **Old devices keep what they had.** Removing someone stops them reading
   new messages. It cannot make them forget what their device already
   decrypted.
5. **A compromised device is compromised.** Malware on your computer can read
   what you read. Pravda protects data in transit and on the server, not on a
   device someone else controls.
6. **Disappearing messages** are deleted from the server and from every
   client that is online or reconnects. A recipient can still copy or
   photograph a message before it disappears.

## The desktop app

- The app loads its bundled client from its own `app://pravda` origin with a
  strict Content Security Policy. The page runs sandboxed, with context
  isolation and no Node.js; it reaches the shell only through a small,
  checked bridge.
- Session tokens are encrypted with the operating system's keychain: Keychain
  on macOS, DPAPI on Windows, KWallet or the Secret Service on Linux. On a
  Linux desktop with no keyring, Electron can only obscure the file, which is
  roughly what a browser does with its cookies. Your encryption keys stay in
  the app's own browser storage, protected by your operating system account,
  as in any desktop chat app.
- A server with a self-signed certificate (typical on a home network) is
  never trusted silently. The app shows the certificate's fingerprint and
  asks. After that it pins exactly that certificate for that address and
  warns if it ever changes. The person running the server can read their
  fingerprint from the app's hosting page or the server's log.
- Links open in your normal browser. The app window cannot navigate away from
  Pravda.

## Updates to the desktop app

The desktop app updates itself from this repository's GitHub releases
([docs/updates.md](docs/updates.md)). Each release carries a manifest listing
every download's size and SHA-256. The manifest is signed with Pravda's
Ed25519 release key, whose public half is built into the app
(`desktop/release-key.pem`). An update installs only when the signature
checks out, the version is newer, and the download matches the signed
checksum. A compromised download host therefore cannot push code, and neither
can a release that is unsigned or signed with another key.

The private key is held by the maintainer and as an encrypted GitHub Actions
secret used only by the release workflow. Anyone who could change that
workflow, or who stole the key, could sign an update; protect the repository
accordingly. Updates can be switched off in Settings, Desktop app.

## Running a server safely

- Use HTTPS: `--domain` gets a Let's Encrypt certificate automatically, and
  `--tls-self-signed` covers a LAN. Browsers refuse microphones and cameras
  without it, and without it tokens could be intercepted.
- `instance.key` in the data directory seals the server's own secrets
  (authenticator seeds, server passwords). Back it up together with the
  database, and keep both private.
- Keep the server updated. Run it as an unprivileged user.

See [docs/HOSTING.md](docs/HOSTING.md) for the details.

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use
**Report a vulnerability** under the repository's
[Security tab](https://github.com/DJagerStudios/pravda/security/advisories/new),
with enough detail to reproduce the problem. We will confirm receipt, work on
a fix, and credit you unless you prefer otherwise.
