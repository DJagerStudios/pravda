package store

import (
	"context"
	"database/sql"
	"errors"

	"pravda/internal/id"
)

// SealedKey is a symmetric key sealed for one recipient.
type SealedKey struct {
	Epoch    int    `json:"epoch,omitempty"`
	UserID   id.ID  `json:"user_id"`
	SenderID id.ID  `json:"sender_id"`
	Wrapped  string `json:"wrapped"`
}

// ErrStaleEpoch means a key generation changed underneath the caller.
var ErrStaleEpoch = errors.New("the key generation changed; fetch it again")

// ChannelKeysFor returns every key generation of a channel sealed for a user.
func (s *Store) ChannelKeysFor(ctx context.Context, channel, user id.ID) ([]SealedKey, error) {
	return queryRows(ctx, s.r, func(r rowScanner) (SealedKey, error) {
		k := SealedKey{UserID: user}
		err := r.Scan(&k.Epoch, &k.SenderID, &k.Wrapped)
		return k, err
	}, `SELECT epoch, sender_id, wrapped FROM channel_keys WHERE channel_id = ? AND user_id = ? ORDER BY epoch`, channel, user)
}

// EpochHolders lists who holds a given generation of a channel's key.
func (s *Store) EpochHolders(ctx context.Context, channel id.ID, epoch int) ([]id.ID, error) {
	return queryRows(ctx, s.r, scanID, `SELECT user_id FROM channel_keys WHERE channel_id = ? AND epoch = ?`, channel, epoch)
}

// HeldEpochs lists the generations of a channel's key a user holds.
func (s *Store) HeldEpochs(ctx context.Context, channel, user id.ID) ([]int, error) {
	return queryRows(ctx, s.r, func(r rowScanner) (int, error) {
		var e int
		err := r.Scan(&e)
		return e, err
	}, `SELECT epoch FROM channel_keys WHERE channel_id = ? AND user_id = ? ORDER BY epoch`, channel, user)
}

// RotateChannelKey starts a new key generation. It succeeds only if the
// channel is still at previous, so two members rotating at once cannot both
// win.
func (s *Store) RotateChannelKey(ctx context.Context, channel id.ID, previous int, sender id.ID, keys []SealedKey) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE channels SET key_epoch = key_epoch + 1 WHERE id = ? AND key_epoch = ?`, channel, previous)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrStaleEpoch
		}
		for _, k := range keys {
			if _, err := tx.ExecContext(ctx, `INSERT INTO channel_keys (channel_id, epoch, user_id, sender_id, wrapped, created_at) VALUES (?,?,?,?,?,?)`,
				channel, previous+1, k.UserID, sender, k.Wrapped, now()); err != nil {
				return err
			}
		}
		return nil
	})
}

// ShareChannelKeys stores sealed copies of an existing generation. Copies a
// recipient already has are left alone: the first share wins.
func (s *Store) ShareChannelKeys(ctx context.Context, channel id.ID, epoch int, sender id.ID, keys []SealedKey) (added []id.ID, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		for _, k := range keys {
			res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO channel_keys (channel_id, epoch, user_id, sender_id, wrapped, created_at) VALUES (?,?,?,?,?,?)`,
				channel, epoch, k.UserID, sender, k.Wrapped, now())
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n > 0 {
				added = append(added, k.UserID)
			}
		}
		return nil
	})
	return added, err
}

// ServerKeyFor returns a user's sealed copy of a server's metadata key.
func (s *Store) ServerKeyFor(ctx context.Context, server, user id.ID) (SealedKey, error) {
	k := SealedKey{UserID: user}
	err := s.r.QueryRowContext(ctx, `SELECT sender_id, wrapped FROM server_keys WHERE server_id = ? AND user_id = ?`, server, user).Scan(&k.SenderID, &k.Wrapped)
	return k, notFound(err)
}

// ServerKeyHolders lists who holds a server's metadata key.
func (s *Store) ServerKeyHolders(ctx context.Context, server id.ID) ([]id.ID, error) {
	return queryRows(ctx, s.r, scanID, `SELECT user_id FROM server_keys WHERE server_id = ?`, server)
}

// ShareServerKeys stores sealed copies of a server's metadata key.
func (s *Store) ShareServerKeys(ctx context.Context, server, sender id.ID, keys []SealedKey) (added []id.ID, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		for _, k := range keys {
			res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO server_keys (server_id, user_id, sender_id, wrapped, created_at) VALUES (?,?,?,?,?)`,
				server, k.UserID, sender, k.Wrapped, now())
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n > 0 {
				added = append(added, k.UserID)
			}
		}
		return nil
	})
	return added, err
}
