# Pravda protocol notes

How the client and server talk, and the formats of everything encrypted.
[SECURITY.md](../SECURITY.md) explains the security reasoning; this page is
the reference.

## Identifiers

Every object has a 63-bit ID: milliseconds since 2026-01-01 UTC in the high
bits and a 12-bit counter in the low bits, so IDs sort by creation time. They
travel as JSON strings, because JavaScript numbers lose precision past 53
bits.

## HTTP API

Everything lives under `/api/v1`, speaks JSON, and authenticates with the
session cookie (browsers on the same site) or `Authorization: Bearer <token>`
(the desktop app, from its own origin). Cross-origin requests may use bearer
tokens only; cookies are refused from other origins.

Errors look like `{"code": "rate_limited", "message": "…"}` with a matching
HTTP status.

| Area | Routes |
| --- | --- |
| Instance | `GET /instance` |
| Sign-in | `POST /auth/prelogin` (the salt and iteration count for a username), `POST /auth/register`, `POST /auth/login`, `POST /auth/login/mfa`, `POST /auth/logout`, `POST /auth/recover`, `POST /auth/recover/complete` |
| Authenticator | `POST /auth/totp/setup`, `POST /auth/totp/enable`, `POST /auth/totp/disable`, `POST /auth/recovery-codes` |
| Account | `GET/PATCH /users/@me`, `GET /users/@me/bundle`, `PUT /users/@me/password`, `PUT /users/@me/keys`, `GET /users/@me/sessions`, `DELETE /users/@me/sessions/{id}`, `GET /users/{id}` |
| Friends and DMs | `GET/POST /relationships`, `PUT/DELETE /relationships/{user}`, `POST /dms`, `DELETE /dms/{channel}` |
| Servers | `POST /servers`, `PATCH/DELETE /servers/{id}`, `POST /servers/{id}/leave`, `GET/PUT /servers/{id}/gate`, `GET /servers/{id}/invites`, `GET /servers/{id}/audit` |
| Members and bans | `PATCH/DELETE /servers/{id}/members/{user}`, `GET /servers/{id}/bans`, `PUT/DELETE /servers/{id}/bans/{user}`, `POST /servers/{id}/voice/{user}/disconnect` |
| Roles | `POST /servers/{id}/roles`, `PUT /servers/{id}/roles/order`, `PATCH/DELETE /servers/{id}/roles/{role}` |
| Channels | `POST /servers/{id}/channels`, `PUT /servers/{id}/channels/order`, `PATCH/DELETE /channels/{id}`, `PUT/DELETE /channels/{id}/overwrites/{role or member}/{target}` |
| Messages | `GET/POST /channels/{id}/messages`, `PATCH/DELETE /channels/{id}/messages/{msg}`, reactions, pins, `POST /channels/{id}/typing`, `POST /channels/{id}/read` |
| Keys | `GET/POST /servers/{id}/keys`, `POST /servers/{id}/keys/request`, `GET/POST /channels/{id}/keys`, `POST /channels/{id}/keys/request` |
| Invites | `GET /invites/{code}` (preview), `POST /invites/{code}` (join), `DELETE /invites/{code}`, `POST /channels/{id}/invites` |
| Files | `POST /uploads`; files are served from `/media/{id}/{name}` |

Writes are rate limited per account (messages, uploads, general writes) and
sign-in per address.

## The gateway

A WebSocket at `/gateway` carries everything realtime. Frames are JSON:
`{"op": "…", "d": {…}}` from the client, and `{"op": "event", "t": "…",
"s": <seq>, "d": {…}}` for events from the server.

1. The server sends `hello` with the heartbeat interval and its clock.
2. The client sends `identify` (with its token if it is not on the same
   site), or `resume` with its session ID and the last sequence number it saw.
3. The server answers `ready` with everything the client needs to draw: the
   account, servers with members and roles, channels, DMs, relationships,
   presences, read states and calls in progress.
4. Events follow, each numbered. A dropped connection lingers briefly; a
   `resume` within that time replays exactly the events that were missed.
5. The client sends `ping` on the heartbeat; `pong` carries the server's
   clock, which keeps watch-together in step. `bye` ends the session at once.

Events include `message.create`, `message.update`, `message.delete`,
`reaction.add`, `reaction.remove`, `typing.start`, `read.update`,
`mention.create`, `channel.*`, `role.*`, `member.*`, `server.*`,
`presence.update`, `user.update`, `relationship.*`, `dm.*`, `keys.request`,
`keys.available`, `keys.rotate`, `keys.rotated`, `call.ring`, `call.end`,
`voice.*` and `watch.state`.

Voice and watch-together operations travel over the same socket:
`voice_join`, `voice_leave`, `voice_state` (mute, deafen, camera, screen),
`voice_signal` (WebRTC offers, answers and ICE candidates), `voice_watch`
(whose screen you are watching), `watch_set` and `watch_clear`.

## Calls

Each participant holds two WebRTC peer connections with the server's SFU:

- **publish**: the client offers once, with four send-only transceivers
  (microphone, camera, screen, screen audio) that it fills or empties as
  needed;
- **subscribe**: the server offers whenever the set of forwarded streams
  changes.

Media uses one UDP port for everyone, with a TCP fallback. The server reads
only the standard audio-level header (for speaking indicators) and the RTP
headers it needs to forward packets. Screens are forwarded only to people who
choose to watch them, which saves bandwidth.

## Encrypted formats

### Envelopes

Messages, reactions, metadata and watch-together state share one format:

```json
{ "v": 1, "e": 3, "iv": "<base64 12 bytes>", "ct": "<base64>", "sig": "<base64>" }
```

- `e` is the key generation (omitted for server metadata).
- `ct` is AES-256-GCM over the JSON body, with associated data binding it to
  its place, so ciphertext cannot be moved between channels or authors:
  - message: `pravda/msg/v1|<channel>|<author>|<epoch>`
  - reaction: `pravda/react/v1|<message>|<user>|<epoch>`
  - server, channel or role names: `pravda/meta/v1|server`, `…|channel`,
    `…|role`
  - group conversation names: `pravda/meta/v1|group|<channel>`
- `sig` (messages, reactions, watch state) is the author's ECDSA P-256
  signature over `<aad>|<iv>|<ct>`, so even someone holding the channel key
  cannot forge another member's message.

A message body is `{"t": "<markdown text>", "a": [attachments]}`. Each
attachment carries its own file key and IV: `{"id", "name", "type", "size",
"key", "iv", "w", "h"}`. Files are uploaded as opaque ciphertext. Alongside
the envelope, the client sends what the server needs in the clear: the message
it replies to, the IDs of attached uploads, and who it mentions.

### Sealed keys

A channel or server key is shared with a member by sealing it to them:

1. ECDH between the sharer's and the recipient's identity keys.
2. HKDF-SHA-256 with salt `pravda/wrap/v1|<scope>|<epoch>` and info
   `<from>><to>`, giving an AES-256-GCM key.
3. The 32-byte key, encrypted with it.

The server stores one sealed copy per member and generation. A client that
lacks a key asks for it (`keys/request`). The server passes the request to
online members who hold the key, and they seal it to the people the server
names. That is why the server's member list matters (see SECURITY.md).

### The key backup

The account's private keys are stored on the server sealed with the wrap key
(AES-256-GCM, associated data `pravda/bundle/v1`). The wrap key comes from
the password: PBKDF2-SHA-256 with 600,000 iterations gives 512 bits, of which
the first half is the auth key the server checks and the second the wrap key.
The recovery key opens a second copy, using HKDF labels `wrap` and `auth`.

### Media frames

Call media is encrypted per frame in a worker (`RTCRtpScriptTransform`, or
encoded insertable streams on older browsers):

```
[readable header][AES-256-GCM ciphertext][12-byte IV][1-byte key index]
```

The readable header is 10 bytes for VP8 keyframes, 3 for other VP8 frames
and 1 for Opus, because the receiving browser needs those bytes to reassemble
the stream. It is authenticated as associated data. The call key for a
generation is HKDF-SHA-256 of the channel key with salt `pravda/media/v1` and
info `<channel>|<epoch>`. Frames are dropped, never sent in the clear, until
a key is available. VP8 is used for video because its header boundaries are
known.

### Invite links

`https://<server>/invite/<code>#<base64url server key>`

The preview (`GET /invites/{code}`) returns the encrypted server name, which
the link's key decrypts. The key is in the fragment, so browsers never send
it to any server.
