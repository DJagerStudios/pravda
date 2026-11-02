package store

import (
	"context"
	"database/sql"

	"pravda/internal/id"
)

// User is the public profile everyone may see, including the public halves
// of the user's identity keys.
type User struct {
	ID           id.ID  `json:"id"`
	Username     string `json:"username"`
	DisplayName  string `json:"display_name"`
	Avatar       string `json:"avatar,omitempty"`
	Banner       string `json:"banner,omitempty"`
	BannerColor  int    `json:"banner_color,omitempty"`
	AccentColor  int    `json:"accent_color,omitempty"`
	Pronouns     string `json:"pronouns,omitempty"`
	Bio          string `json:"bio,omitempty"`
	CustomStatus string `json:"custom_status,omitempty"`
	SignKey      string `json:"sign_key"`
	DHKey        string `json:"dh_key"`
	CreatedAt    int64  `json:"created_at"`
}

// Account adds what only the user themselves may see.
type Account struct {
	User
	Status      string `json:"status"`
	IsAdmin     bool   `json:"is_admin"`
	TOTPEnabled bool   `json:"totp_enabled"`
}

const userCols = `id, username, display_name, avatar, banner, banner_color, accent_color, pronouns, bio, custom_status, sign_key, dh_key, created_at`

func scanUser(r rowScanner) (User, error) {
	var u User
	err := r.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Avatar, &u.Banner, &u.BannerColor, &u.AccentColor,
		&u.Pronouns, &u.Bio, &u.CustomStatus, &u.SignKey, &u.DHKey, &u.CreatedAt)
	return u, err
}

// NewUser holds what registration stores.
type NewUser struct {
	Username       string
	DisplayName    string
	AuthHash       string
	KDFSalt        string
	KDFIterations  int
	SignKey        string
	DHKey          string
	KeyBundle      string
	RecoveryBundle string
	RecoveryAuth   string // Argon2id hash
}

// CreateUser registers an account. The very first account becomes the
// instance administrator.
func (s *Store) CreateUser(ctx context.Context, n NewUser) (Account, error) {
	var a Account
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
			return err
		}
		a = Account{
			User: User{
				ID: s.IDs.Next(), Username: n.Username, DisplayName: n.DisplayName,
				SignKey: n.SignKey, DHKey: n.DHKey, CreatedAt: now(),
			},
			Status:  "online",
			IsAdmin: count == 0,
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO users (id, username, display_name, auth_hash, kdf_salt, kdf_iterations,
			sign_key, dh_key, key_bundle, recovery_bundle, recovery_auth, is_admin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			a.ID, n.Username, n.DisplayName, n.AuthHash, n.KDFSalt, n.KDFIterations, n.SignKey, n.DHKey, n.KeyBundle,
			n.RecoveryBundle, n.RecoveryAuth, a.IsAdmin, a.CreatedAt)
		if isUnique(err) {
			return ErrConflict
		}
		return err
	})
	return a, err
}

// UserCount returns the number of accounts.
func (s *Store) UserCount(ctx context.Context) (int, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// GetUser fetches a public profile.
func (s *Store) GetUser(ctx context.Context, user id.ID) (User, error) {
	u, err := scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, user))
	return u, notFound(err)
}

// GetAccount fetches the private view of a user.
func (s *Store) GetAccount(ctx context.Context, user id.ID) (Account, error) {
	var a Account
	err := s.r.QueryRowContext(ctx, `SELECT `+userCols+`, status, is_admin, totp_enabled FROM users WHERE id = ?`, user).Scan(
		&a.ID, &a.Username, &a.DisplayName, &a.Avatar, &a.Banner, &a.BannerColor, &a.AccentColor, &a.Pronouns, &a.Bio,
		&a.CustomStatus, &a.SignKey, &a.DHKey, &a.CreatedAt, &a.Status, &a.IsAdmin, &a.TOTPEnabled)
	return a, notFound(err)
}

// FindUser looks a user up by username, case-insensitively.
func (s *Store) FindUser(ctx context.Context, username string) (User, error) {
	u, err := scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE username = ?`, username))
	return u, notFound(err)
}

// Credentials is what signing in needs to check.
type Credentials struct {
	UserID        id.ID
	AuthHash      string
	KDFSalt       string
	KDFIterations int
	TOTPEnabled   bool
}

// CredentialsFor returns a user's sign-in material by username.
func (s *Store) CredentialsFor(ctx context.Context, username string) (Credentials, error) {
	var c Credentials
	err := s.r.QueryRowContext(ctx, `SELECT id, auth_hash, kdf_salt, kdf_iterations, totp_enabled FROM users WHERE username = ?`,
		username).Scan(&c.UserID, &c.AuthHash, &c.KDFSalt, &c.KDFIterations, &c.TOTPEnabled)
	return c, notFound(err)
}

// CredentialsByID returns a user's sign-in material.
func (s *Store) CredentialsByID(ctx context.Context, user id.ID) (Credentials, error) {
	c := Credentials{UserID: user}
	err := s.r.QueryRowContext(ctx, `SELECT auth_hash, kdf_salt, kdf_iterations, totp_enabled FROM users WHERE id = ?`,
		user).Scan(&c.AuthHash, &c.KDFSalt, &c.KDFIterations, &c.TOTPEnabled)
	return c, notFound(err)
}

// RecoveryInfo is what a password reset by recovery key needs to check.
type RecoveryInfo struct {
	UserID      id.ID
	AuthHash    string
	TOTPEnabled bool
	Bundle      string
}

// RecoveryFor returns a user's recovery material by username.
func (s *Store) RecoveryFor(ctx context.Context, username string) (RecoveryInfo, error) {
	var v RecoveryInfo
	err := s.r.QueryRowContext(ctx, `SELECT id, recovery_auth, totp_enabled, recovery_bundle FROM users WHERE username = ?`, username).Scan(
		&v.UserID, &v.AuthHash, &v.TOTPEnabled, &v.Bundle)
	return v, notFound(err)
}

// KeyBundle is a user's sealed private keys and the parameters to unseal them.
type KeyBundle struct {
	Bundle         string `json:"bundle"`
	RecoveryBundle string `json:"recovery_bundle"`
	KDFSalt        string `json:"kdf_salt"`
	KDFIterations  int    `json:"kdf_iterations"`
}

// GetKeyBundle returns a user's sealed private keys.
func (s *Store) GetKeyBundle(ctx context.Context, user id.ID) (KeyBundle, error) {
	var b KeyBundle
	err := s.r.QueryRowContext(ctx, `SELECT key_bundle, recovery_bundle, kdf_salt, kdf_iterations FROM users WHERE id = ?`, user).Scan(
		&b.Bundle, &b.RecoveryBundle, &b.KDFSalt, &b.KDFIterations)
	return b, notFound(err)
}

// ChangePassword replaces the sign-in material and the password-sealed bundle.
// The identity keys stay the same, so nothing else needs to change.
func (s *Store) ChangePassword(ctx context.Context, user id.ID, authHash, salt string, iterations int, bundle string) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE users SET auth_hash = ?, kdf_salt = ?, kdf_iterations = ?, key_bundle = ? WHERE id = ?`,
		authHash, salt, iterations, bundle, user))
}

// ResetKeys replaces a user's identity. Every sealed key addressed to the old
// identity becomes useless, so those are dropped and must be re-shared.
func (s *Store) ResetKeys(ctx context.Context, user id.ID, signKey, dhKey, bundle, recovery string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := checkAffected(tx.ExecContext(ctx, `UPDATE users SET sign_key = ?, dh_key = ?, key_bundle = ?, recovery_bundle = ? WHERE id = ?`,
			signKey, dhKey, bundle, recovery, user)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM channel_keys WHERE user_id = ?`, user); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM server_keys WHERE user_id = ?`, user)
		return err
	})
}

// TOTPState is a user's authenticator configuration (secrets still sealed).
type TOTPState struct {
	Secret   []byte
	Pending  []byte
	Enabled  bool
	LastStep int64
}

// GetTOTP returns a user's authenticator state.
func (s *Store) GetTOTP(ctx context.Context, user id.ID) (TOTPState, error) {
	var t TOTPState
	err := s.w.QueryRowContext(ctx, `SELECT totp_secret, totp_pending, totp_enabled, totp_last_step FROM users WHERE id = ?`, user).Scan(
		&t.Secret, &t.Pending, &t.Enabled, &t.LastStep)
	return t, notFound(err)
}

// SetTOTPPending stores a freshly generated, not yet confirmed secret.
func (s *Store) SetTOTPPending(ctx context.Context, user id.ID, sealed []byte) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE users SET totp_pending = ? WHERE id = ?`, sealed, user))
}

// EnableTOTP promotes the pending secret, records the step just used, and
// replaces the recovery codes.
func (s *Store) EnableTOTP(ctx context.Context, user id.ID, step int64, codeHashes [][]byte) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := checkAffected(tx.ExecContext(ctx, `UPDATE users SET totp_secret = totp_pending, totp_pending = NULL,
			totp_enabled = 1, totp_last_step = ? WHERE id = ? AND totp_pending IS NOT NULL`, step, user)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_codes WHERE user_id = ?`, user); err != nil {
			return err
		}
		for _, h := range codeHashes {
			if _, err := tx.ExecContext(ctx, `INSERT INTO recovery_codes (user_id, code_hash) VALUES (?,?)`, user, h); err != nil {
				return err
			}
		}
		// The account is now complete: every login it holds becomes full.
		_, err := tx.ExecContext(ctx, `UPDATE sessions SET stage = 'full' WHERE user_id = ?`, user)
		return err
	})
}

// AdvanceTOTPStep records a used time step, refusing to go backwards so a
// code can never be replayed. It reports whether the step was new.
func (s *Store) AdvanceTOTPStep(ctx context.Context, user id.ID, step int64) (bool, error) {
	res, err := s.w.ExecContext(ctx, `UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?`, step, user, step)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// DisableTOTP removes the authenticator and recovery codes.
func (s *Store) DisableTOTP(ctx context.Context, user id.ID) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := checkAffected(tx.ExecContext(ctx, `UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0 WHERE id = ?`, user)); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM recovery_codes WHERE user_id = ?`, user)
		return err
	})
}

// UseRecoveryCode consumes a recovery code. It reports whether it existed.
func (s *Store) UseRecoveryCode(ctx context.Context, user id.ID, codeHash []byte) (bool, error) {
	res, err := s.w.ExecContext(ctx, `DELETE FROM recovery_codes WHERE user_id = ? AND code_hash = ?`, user, codeHash)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RecoveryCodesLeft counts unused recovery codes.
func (s *Store) RecoveryCodesLeft(ctx context.Context, user id.ID) (int, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_codes WHERE user_id = ?`, user).Scan(&n)
	return n, err
}

// UsersByID fetches several profiles at once.
func (s *Store) UsersByID(ctx context.Context, ids []id.ID) ([]User, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	ph, args := placeholders(ids)
	return queryRows(ctx, s.r, scanUser, `SELECT `+userCols+` FROM users WHERE id IN (`+ph+`)`, args...)
}

// ProfilePatch holds optional changes to a profile. Nil fields stay as they are.
type ProfilePatch struct {
	DisplayName  *string `json:"display_name"`
	Avatar       *string `json:"avatar"`
	Banner       *string `json:"banner"`
	BannerColor  *int    `json:"banner_color"`
	AccentColor  *int    `json:"accent_color"`
	Pronouns     *string `json:"pronouns"`
	Bio          *string `json:"bio"`
	CustomStatus *string `json:"custom_status"`
	Status       *string `json:"status"`
}

// UpdateProfile applies a patch.
func (s *Store) UpdateProfile(ctx context.Context, user id.ID, p ProfilePatch) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE users SET
		display_name  = COALESCE(?, display_name),
		avatar        = COALESCE(?, avatar),
		banner        = COALESCE(?, banner),
		banner_color  = COALESCE(?, banner_color),
		accent_color  = COALESCE(?, accent_color),
		pronouns      = COALESCE(?, pronouns),
		bio           = COALESCE(?, bio),
		custom_status = COALESCE(?, custom_status),
		status        = COALESCE(?, status)
		WHERE id = ?`, p.DisplayName, p.Avatar, p.Banner, p.BannerColor, p.AccentColor, p.Pronouns, p.Bio, p.CustomStatus, p.Status, user))
}

// Session is one logged-in device.
type Session struct {
	ID        id.ID  `json:"id"`
	Label     string `json:"label"`
	CreatedAt int64  `json:"created_at"`
	LastSeen  int64  `json:"last_seen"`
}

// CreateSession stores a login. Only the hash of the token is kept.
func (s *Store) CreateSession(ctx context.Context, user id.ID, tokenHash []byte, stage, label string) (id.ID, error) {
	t := now()
	session := s.IDs.Next()
	_, err := s.w.ExecContext(ctx, `INSERT INTO sessions (id, token_hash, user_id, stage, label, created_at, last_seen) VALUES (?,?,?,?,?,?,?)`,
		session, tokenHash, user, stage, label, t, t)
	return session, err
}

// SessionInfo is what authenticating a token yields.
type SessionInfo struct {
	User     id.ID
	Session  id.ID
	Stage    string
	LastSeen int64
}

// SessionOwner resolves a token hash to its user.
func (s *Store) SessionOwner(ctx context.Context, tokenHash []byte) (SessionInfo, error) {
	var v SessionInfo
	err := s.r.QueryRowContext(ctx, `SELECT user_id, id, stage, last_seen FROM sessions WHERE token_hash = ?`, tokenHash).Scan(
		&v.User, &v.Session, &v.Stage, &v.LastSeen)
	return v, notFound(err)
}

// TouchSession records that a session was used.
func (s *Store) TouchSession(ctx context.Context, session id.ID) error {
	_, err := s.w.ExecContext(ctx, `UPDATE sessions SET last_seen = ? WHERE id = ?`, now(), session)
	return err
}

// ListSessions returns a user's logins, newest first.
func (s *Store) ListSessions(ctx context.Context, user id.ID) ([]Session, error) {
	return queryRows(ctx, s.r, func(r rowScanner) (Session, error) {
		var v Session
		err := r.Scan(&v.ID, &v.Label, &v.CreatedAt, &v.LastSeen)
		return v, err
	}, `SELECT id, label, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC`, user)
}

// DeleteSession revokes one login belonging to a user.
func (s *Store) DeleteSession(ctx context.Context, user, session id.ID) error {
	return checkAffected(s.w.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND id = ?`, user, session))
}

// DeleteOtherSessions revokes every login of a user except keep.
func (s *Store) DeleteOtherSessions(ctx context.Context, user, keep id.ID) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND id != ?`, user, keep)
	return err
}

// Relationship links the owner of a row to another user.
type Relationship struct {
	UserID id.ID  `json:"user_id"`
	Kind   string `json:"kind"`
}

// Relationships lists a user's friends, requests and blocks.
func (s *Store) Relationships(ctx context.Context, user id.ID) ([]Relationship, error) {
	return queryRows(ctx, s.r, func(r rowScanner) (Relationship, error) {
		var v Relationship
		err := r.Scan(&v.UserID, &v.Kind)
		return v, err
	}, `SELECT other_id, kind FROM relationships WHERE user_id = ?`, user)
}

// RelationshipKind returns the owner's view of their link to other, or "".
func (s *Store) RelationshipKind(ctx context.Context, user, other id.ID) (string, error) {
	var kind string
	err := s.r.QueryRowContext(ctx, `SELECT kind FROM relationships WHERE user_id = ? AND other_id = ?`, user, other).Scan(&kind)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return kind, err
}

// SetRelationshipPair atomically sets both directions of a relationship. An
// empty kind deletes that direction.
func (s *Store) SetRelationshipPair(ctx context.Context, a, b id.ID, kindAB, kindBA string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		set := func(from, to id.ID, kind string) error {
			if kind == "" {
				_, err := tx.ExecContext(ctx, `DELETE FROM relationships WHERE user_id = ? AND other_id = ?`, from, to)
				return err
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO relationships (user_id, other_id, kind, created_at) VALUES (?,?,?,?)
				ON CONFLICT (user_id, other_id) DO UPDATE SET kind = excluded.kind`, from, to, kind, now())
			return err
		}
		if err := set(a, b, kindAB); err != nil {
			return err
		}
		return set(b, a, kindBA)
	})
}

// ContactIDs lists everyone who should hear about a user's presence: people
// sharing a server, friends and DM partners.
func (s *Store) ContactIDs(ctx context.Context, user id.ID) ([]id.ID, error) {
	return queryRows(ctx, s.r, scanID, `SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.server_id = m2.server_id WHERE m1.user_id = ?1
		UNION SELECT other_id FROM relationships WHERE user_id = ?1 AND kind = 'friend'
		UNION SELECT d2.user_id FROM dm_participants d1 JOIN dm_participants d2 ON d1.channel_id = d2.channel_id WHERE d1.user_id = ?1`, user)
}
