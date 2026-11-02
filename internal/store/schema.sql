-- Pravda schema, version 1.
--
-- Everything people write is end-to-end encrypted. Columns that hold
-- ciphertext are named `meta` (names, topics, descriptions) or `content`
-- (messages, reactions); the server stores and relays them but cannot read
-- them. Optional references use 0 for "none" rather than NULL so every ID
-- column scans straight into id.ID.

CREATE TABLE users (
    id              INTEGER PRIMARY KEY,
    username        TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    display_name    TEXT    NOT NULL,
    -- Argon2id of the key the client derives from the password. The password
    -- itself never reaches the server.
    auth_hash       TEXT    NOT NULL,
    kdf_salt        TEXT    NOT NULL,
    kdf_iterations  INTEGER NOT NULL,
    -- Public identity keys (P-256, SPKI, base64) and the private keys sealed
    -- with a key only the user's password (or recovery key) can produce.
    sign_key        TEXT    NOT NULL,
    dh_key          TEXT    NOT NULL,
    key_bundle      TEXT    NOT NULL,
    recovery_bundle TEXT    NOT NULL DEFAULT '',
    -- Argon2id of a secret derived from the recovery key: lets its holder
    -- reset a forgotten password (together with the second factor).
    recovery_auth   TEXT    NOT NULL DEFAULT '',
    -- Authenticator secrets, encrypted with the instance key.
    totp_secret     BLOB,
    totp_pending    BLOB,
    totp_enabled    INTEGER NOT NULL DEFAULT 0,
    totp_last_step  INTEGER NOT NULL DEFAULT 0,
    avatar          TEXT    NOT NULL DEFAULT '',
    banner          TEXT    NOT NULL DEFAULT '',
    banner_color    INTEGER NOT NULL DEFAULT 0,
    accent_color    INTEGER NOT NULL DEFAULT 0,
    pronouns        TEXT    NOT NULL DEFAULT '',
    bio             TEXT    NOT NULL DEFAULT '',
    custom_status   TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'online',
    is_admin        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);

-- stage: 'full', or 'enroll' while the user must still set up an authenticator.
CREATE TABLE sessions (
    id         INTEGER PRIMARY KEY,
    token_hash BLOB    NOT NULL UNIQUE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage      TEXT    NOT NULL DEFAULT 'full',
    label      TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE recovery_codes (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash BLOB    NOT NULL,
    PRIMARY KEY (user_id, code_hash)
) WITHOUT ROWID;

-- gate_mode: 'none', 'password' (gate_hash) or 'rotating' (a code derived
-- from gate_secret that changes every gate_period seconds).
CREATE TABLE servers (
    id                INTEGER PRIMARY KEY,
    meta              TEXT    NOT NULL,
    icon_attachment   INTEGER NOT NULL DEFAULT 0,
    owner_id          INTEGER NOT NULL REFERENCES users(id),
    system_channel_id INTEGER NOT NULL DEFAULT 0,
    history_visible   INTEGER NOT NULL DEFAULT 1,
    gate_mode         TEXT    NOT NULL DEFAULT 'none',
    gate_hash         TEXT    NOT NULL DEFAULT '',
    gate_secret       BLOB,
    gate_period       INTEGER NOT NULL DEFAULT 300,
    created_at        INTEGER NOT NULL
);

CREATE TABLE members (
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nick        TEXT    NOT NULL DEFAULT '',
    server_mute INTEGER NOT NULL DEFAULT 0,
    server_deaf INTEGER NOT NULL DEFAULT 0,
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
) WITHOUT ROWID;
CREATE INDEX members_user ON members(user_id);

CREATE TABLE roles (
    id          INTEGER PRIMARY KEY,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    meta        TEXT    NOT NULL,
    color       INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    hoist       INTEGER NOT NULL DEFAULT 0,
    mentionable INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX roles_server ON roles(server_id);

CREATE TABLE member_roles (
    server_id INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    role_id   INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, user_id, role_id),
    FOREIGN KEY (server_id, user_id) REFERENCES members(server_id, user_id) ON DELETE CASCADE
) WITHOUT ROWID;

-- key_epoch: the channel's current encryption key generation. 0 means no key
-- has been made yet. ttl_seconds: messages disappear this long after posting.
CREATE TABLE channels (
    id              INTEGER PRIMARY KEY,
    server_id       INTEGER NOT NULL DEFAULT 0,
    kind            TEXT    NOT NULL,
    meta            TEXT    NOT NULL DEFAULT '',
    position        INTEGER NOT NULL DEFAULT 0,
    parent_id       INTEGER NOT NULL DEFAULT 0,
    owner_id        INTEGER NOT NULL DEFAULT 0,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    message_count   INTEGER NOT NULL DEFAULT 0,
    user_limit      INTEGER NOT NULL DEFAULT 0,
    key_epoch       INTEGER NOT NULL DEFAULT 0,
    ttl_seconds     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);
CREATE INDEX channels_server ON channels(server_id);

CREATE TABLE overwrites (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    is_member  INTEGER NOT NULL,
    target_id  INTEGER NOT NULL,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, is_member, target_id)
) WITHOUT ROWID;

CREATE TABLE dm_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hidden     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
) WITHOUT ROWID;
CREATE INDEX dm_participants_user ON dm_participants(user_id);

CREATE TABLE messages (
    id               INTEGER PRIMARY KEY,
    channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id        INTEGER NOT NULL REFERENCES users(id),
    kind             TEXT    NOT NULL DEFAULT 'default',
    content          TEXT    NOT NULL DEFAULT '',
    reply_to         INTEGER NOT NULL DEFAULT 0,
    edited_at        INTEGER NOT NULL DEFAULT 0,
    pinned           INTEGER NOT NULL DEFAULT 0,
    mention_everyone INTEGER NOT NULL DEFAULT 0,
    expires_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_channel ON messages(channel_id, id DESC);
CREATE INDEX messages_expiry ON messages(expires_at) WHERE expires_at > 0;

CREATE TABLE message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
) WITHOUT ROWID;

-- kind: 'message' (members of the channel), 'server' (members of server_id,
-- for encrypted server icons), 'public' (avatars and banners).
CREATE TABLE attachments (
    id          INTEGER PRIMARY KEY,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    message_id  INTEGER NOT NULL DEFAULT 0,
    server_id   INTEGER NOT NULL DEFAULT 0,
    kind        TEXT    NOT NULL DEFAULT 'message',
    filename    TEXT    NOT NULL,
    mime        TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    width       INTEGER NOT NULL DEFAULT 0,
    height      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE INDEX attachments_message ON attachments(message_id);

-- Each reaction is its own ciphertext, so even which emoji was used stays
-- private.
CREATE TABLE reactions (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL,
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX reactions_message ON reactions(message_id);

CREATE TABLE read_states (
    user_id      INTEGER NOT NULL,
    channel_id   INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    mentions     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
) WITHOUT ROWID;

CREATE TABLE invites (
    code       TEXT    PRIMARY KEY,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL DEFAULT 0,
    creator_id INTEGER NOT NULL,
    uses       INTEGER NOT NULL DEFAULT 0,
    max_uses   INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX invites_server ON invites(server_id);

CREATE TABLE bans (
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL,
    reason     TEXT    NOT NULL DEFAULT '',
    banned_by  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
) WITHOUT ROWID;

CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    actor_id  INTEGER NOT NULL,
    action    TEXT    NOT NULL,
    target_id INTEGER NOT NULL DEFAULT 0,
    detail    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX audit_server ON audit_log(server_id, id DESC);

-- kind: 'friend', 'outgoing', 'incoming', 'blocked'. Directed rows.
CREATE TABLE relationships (
    user_id    INTEGER NOT NULL,
    other_id   INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, other_id)
) WITHOUT ROWID;

-- A channel key, sealed for one recipient by a sender (ECDH between their
-- identity keys). The server holds only these sealed copies.
CREATE TABLE channel_keys (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    epoch      INTEGER NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL,
    wrapped    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, epoch, user_id)
) WITHOUT ROWID;
CREATE INDEX channel_keys_user ON channel_keys(user_id);

-- The key that encrypts a server's names, topics and icon.
CREATE TABLE server_keys (
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL,
    wrapped    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
) WITHOUT ROWID;
