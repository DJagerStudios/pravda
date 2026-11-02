package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"pravda/internal/id"
	"pravda/internal/perm"
)

// Server is a community: a set of members, roles and channels. Its name,
// description and icon live in Meta, encrypted with the server's key.
type Server struct {
	ID              id.ID  `json:"id"`
	Meta            string `json:"meta"`
	IconAttachment  id.ID  `json:"icon_attachment"`
	OwnerID         id.ID  `json:"owner_id"`
	SystemChannelID id.ID  `json:"system_channel_id"`
	HistoryVisible  bool   `json:"history_visible"`
	GateMode        string `json:"gate_mode"`
	GatePeriod      int    `json:"gate_period"`
	CreatedAt       int64  `json:"created_at"`
}

// Member is a user's place in a server.
type Member struct {
	ServerID   id.ID   `json:"server_id"`
	UserID     id.ID   `json:"user_id"`
	Nick       string  `json:"nick,omitempty"`
	Roles      []id.ID `json:"roles"`
	ServerMute bool    `json:"server_mute,omitempty"`
	ServerDeaf bool    `json:"server_deaf,omitempty"`
	JoinedAt   int64   `json:"joined_at"`
}

// Role is a set of permissions. The base role shares the server's ID. Its
// name is in Meta, encrypted with the server's key.
type Role struct {
	ID          id.ID     `json:"id"`
	ServerID    id.ID     `json:"server_id"`
	Meta        string    `json:"meta"`
	Color       int       `json:"color"`
	Position    int       `json:"position"`
	Permissions perm.Perm `json:"permissions"`
	Hoist       bool      `json:"hoist"`
	Mentionable bool      `json:"mentionable"`
}

// Overwrite adjusts one role's or member's rights on a channel.
type Overwrite struct {
	ChannelID id.ID     `json:"channel_id"`
	Member    bool      `json:"member"`
	TargetID  id.ID     `json:"target_id"`
	Allow     perm.Perm `json:"allow"`
	Deny      perm.Perm `json:"deny"`
}

// Channel kinds.
const (
	KindText     = "text"
	KindVoice    = "voice"
	KindCategory = "category"
	KindDM       = "dm"
	KindGroup    = "group"
)

// Channel is a place to talk. Its name and topic are in Meta: encrypted with
// the server key for server channels, with the channel's own key for groups.
type Channel struct {
	ID            id.ID       `json:"id"`
	ServerID      id.ID       `json:"server_id"`
	Kind          string      `json:"kind"`
	Meta          string      `json:"meta"`
	Position      int         `json:"position"`
	ParentID      id.ID       `json:"parent_id"`
	OwnerID       id.ID       `json:"owner_id"`
	LastMessageID id.ID       `json:"last_message_id"`
	MessageCount  int64       `json:"message_count"`
	UserLimit     int         `json:"user_limit"`
	KeyEpoch      int         `json:"key_epoch"`
	TTLSeconds    int         `json:"ttl_seconds"`
	Overwrites    []Overwrite `json:"overwrites,omitempty"`
	Recipients    []id.ID     `json:"recipients,omitempty"`
	Perms         perm.Perm   `json:"perms"`
}

// IsPrivate reports whether the channel is a DM or group DM.
func (c Channel) IsPrivate() bool { return c.ServerID == 0 }

const channelCols = `id, server_id, kind, meta, position, parent_id, owner_id, last_message_id, message_count, user_limit, key_epoch, ttl_seconds`

func scanChannel(r rowScanner) (Channel, error) {
	var c Channel
	err := r.Scan(&c.ID, &c.ServerID, &c.Kind, &c.Meta, &c.Position, &c.ParentID, &c.OwnerID, &c.LastMessageID, &c.MessageCount,
		&c.UserLimit, &c.KeyEpoch, &c.TTLSeconds)
	return c, err
}

const serverCols = `id, meta, icon_attachment, owner_id, system_channel_id, history_visible, gate_mode, gate_period, created_at`

func scanServer(r rowScanner) (Server, error) {
	var v Server
	err := r.Scan(&v.ID, &v.Meta, &v.IconAttachment, &v.OwnerID, &v.SystemChannelID, &v.HistoryVisible, &v.GateMode, &v.GatePeriod, &v.CreatedAt)
	return v, err
}

// NewRole describes a role created with a server. The first role of a new
// server is its base role.
type NewRole struct {
	Meta        string    `json:"meta"`
	Color       int       `json:"color"`
	Permissions perm.Perm `json:"permissions"`
	Hoist       bool      `json:"hoist"`
	Mentionable bool      `json:"mentionable"`
}

// NewChannel describes a channel created with a server. Parent is the index
// of an earlier category in the same list, or -1.
type NewChannel struct {
	Kind      string `json:"kind"`
	Meta      string `json:"meta"`
	Parent    int    `json:"parent"`
	UserLimit int    `json:"user_limit"`
	System    bool   `json:"system"`
}

// NewServer holds what CreateServer needs. Names arrive already encrypted.
type NewServer struct {
	OwnerID  id.ID
	Meta     string
	Roles    []NewRole
	Channels []NewChannel
}

// CreateServer builds a server from a client-supplied template.
func (s *Store) CreateServer(ctx context.Context, n NewServer) (Server, error) {
	if len(n.Roles) == 0 {
		return Server{}, errors.New("a server needs a base role")
	}
	srv := Server{ID: s.IDs.Next(), Meta: n.Meta, OwnerID: n.OwnerID, HistoryVisible: true, GateMode: "none", GatePeriod: 300, CreatedAt: now()}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO servers (id, meta, owner_id, created_at) VALUES (?,?,?,?)`,
			srv.ID, srv.Meta, srv.OwnerID, srv.CreatedAt); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO members (server_id, user_id, joined_at) VALUES (?,?,?)`, srv.ID, n.OwnerID, srv.CreatedAt); err != nil {
			return err
		}
		for i, r := range n.Roles {
			roleID := s.IDs.Next()
			if i == 0 {
				roleID = srv.ID
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO roles (id, server_id, meta, color, position, permissions, hoist, mentionable) VALUES (?,?,?,?,?,?,?,?)`,
				roleID, srv.ID, r.Meta, r.Color, i, r.Permissions&perm.All, r.Hoist && i > 0, r.Mentionable && i > 0); err != nil {
				return err
			}
		}
		created := make([]id.ID, len(n.Channels))
		positions := map[int]int{}
		for i, c := range n.Channels {
			parent := id.ID(0)
			if c.Parent >= 0 {
				if c.Parent >= i || n.Channels[c.Parent].Kind != KindCategory {
					return fmt.Errorf("channel %d has an invalid parent", i)
				}
				parent = created[c.Parent]
			}
			created[i] = s.IDs.Next()
			position := positions[c.Parent]
			positions[c.Parent]++
			if _, err := tx.ExecContext(ctx, `INSERT INTO channels (id, server_id, kind, meta, position, parent_id, user_limit, created_at) VALUES (?,?,?,?,?,?,?,?)`,
				created[i], srv.ID, c.Kind, c.Meta, position, parent, c.UserLimit, now()); err != nil {
				return err
			}
			if c.System && c.Kind == KindText && srv.SystemChannelID == 0 {
				srv.SystemChannelID = created[i]
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE servers SET system_channel_id = ? WHERE id = ?`, srv.SystemChannelID, srv.ID)
		return err
	})
	return srv, err
}

// GetServer fetches one server.
func (s *Store) GetServer(ctx context.Context, server id.ID) (Server, error) {
	v, err := scanServer(s.r.QueryRowContext(ctx, `SELECT `+serverCols+` FROM servers WHERE id = ?`, server))
	return v, notFound(err)
}

// UserServers lists the servers a user belongs to.
func (s *Store) UserServers(ctx context.Context, user id.ID) ([]Server, error) {
	return queryRows(ctx, s.r, scanServer, `SELECT `+serverCols+` FROM servers WHERE id IN
		(SELECT server_id FROM members WHERE user_id = ?) ORDER BY id`, user)
}

// ServerPatch holds optional changes to a server.
type ServerPatch struct {
	Meta            *string `json:"meta"`
	IconAttachment  *id.ID  `json:"icon_attachment"`
	SystemChannelID *id.ID  `json:"system_channel_id"`
	OwnerID         *id.ID  `json:"owner_id"`
	HistoryVisible  *bool   `json:"history_visible"`
}

// UpdateServer applies a patch.
func (s *Store) UpdateServer(ctx context.Context, server id.ID, p ServerPatch) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE servers SET
		meta = COALESCE(?, meta), icon_attachment = COALESCE(?, icon_attachment),
		system_channel_id = COALESCE(?, system_channel_id), owner_id = COALESCE(?, owner_id),
		history_visible = COALESCE(?, history_visible)
		WHERE id = ?`, p.Meta, p.IconAttachment, p.SystemChannelID, p.OwnerID, p.HistoryVisible, server))
}

// Gate is a server's entry requirement, including its secrets.
type Gate struct {
	Mode   string
	Hash   string
	Secret []byte
	Period int
}

// GetGate returns a server's entry requirement.
func (s *Store) GetGate(ctx context.Context, server id.ID) (Gate, error) {
	var g Gate
	err := s.r.QueryRowContext(ctx, `SELECT gate_mode, gate_hash, gate_secret, gate_period FROM servers WHERE id = ?`, server).Scan(
		&g.Mode, &g.Hash, &g.Secret, &g.Period)
	return g, notFound(err)
}

// SetGate replaces a server's entry requirement.
func (s *Store) SetGate(ctx context.Context, server id.ID, g Gate) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE servers SET gate_mode = ?, gate_hash = ?, gate_secret = ?, gate_period = ? WHERE id = ?`,
		g.Mode, g.Hash, g.Secret, g.Period, server))
}

// DeleteServer removes a server and everything in it. It returns the
// attachments whose files must now be removed from disk.
func (s *Store) DeleteServer(ctx context.Context, server id.ID) ([]id.ID, error) {
	var files []id.ID
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		files, err = collectIDs(ctx, tx, `SELECT a.id FROM attachments a JOIN messages m ON a.message_id = m.id
			JOIN channels c ON m.channel_id = c.id WHERE c.server_id = ?1 UNION SELECT id FROM attachments WHERE server_id = ?1`, server)
		if err != nil {
			return err
		}
		if err := deleteAttachments(ctx, tx, files); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM channels WHERE server_id = ?`, server); err != nil {
			return err
		}
		return checkAffected(tx.ExecContext(ctx, `DELETE FROM servers WHERE id = ?`, server))
	})
	return files, err
}

func collectIDs(ctx context.Context, tx *sql.Tx, q string, args ...any) ([]id.ID, error) {
	rows, err := tx.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []id.ID
	for rows.Next() {
		var v id.ID
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func deleteAttachments(ctx context.Context, tx *sql.Tx, files []id.ID) error {
	if len(files) == 0 {
		return nil
	}
	ph, args := placeholders(files)
	_, err := tx.ExecContext(ctx, `DELETE FROM attachments WHERE id IN (`+ph+`)`, args...)
	return err
}

// AddMember adds a user to a server. Adding an existing member is an error.
func (s *Store) AddMember(ctx context.Context, server, user id.ID) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO members (server_id, user_id, joined_at) VALUES (?,?,?)`, server, user, now())
	if isUnique(err) {
		return ErrConflict
	}
	return err
}

// RemoveMember drops a user from a server, along with their copy of its key.
func (s *Store) RemoveMember(ctx context.Context, server, user id.ID) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM server_keys WHERE server_id = ? AND user_id = ?`, server, user); err != nil {
			return err
		}
		return checkAffected(tx.ExecContext(ctx, `DELETE FROM members WHERE server_id = ? AND user_id = ?`, server, user))
	})
}

// GetMember fetches one member with their roles.
func (s *Store) GetMember(ctx context.Context, server, user id.ID) (Member, error) {
	m := Member{ServerID: server, UserID: user, Roles: []id.ID{}}
	err := s.r.QueryRowContext(ctx, `SELECT nick, server_mute, server_deaf, joined_at FROM members WHERE server_id = ? AND user_id = ?`,
		server, user).Scan(&m.Nick, &m.ServerMute, &m.ServerDeaf, &m.JoinedAt)
	if err != nil {
		return m, notFound(err)
	}
	roles, err := queryRows(ctx, s.r, scanID, `SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?`, server, user)
	if err != nil {
		return m, err
	}
	if roles != nil {
		m.Roles = roles
	}
	return m, nil
}

func scanID(r rowScanner) (id.ID, error) {
	var v id.ID
	err := r.Scan(&v)
	return v, err
}

// ListMembers returns all members of a server.
func (s *Store) ListMembers(ctx context.Context, server id.ID) ([]Member, error) {
	members, err := queryRows(ctx, s.r, func(r rowScanner) (Member, error) {
		m := Member{ServerID: server, Roles: []id.ID{}}
		err := r.Scan(&m.UserID, &m.Nick, &m.ServerMute, &m.ServerDeaf, &m.JoinedAt)
		return m, err
	}, `SELECT user_id, nick, server_mute, server_deaf, joined_at FROM members WHERE server_id = ?`, server)
	if err != nil {
		return nil, err
	}
	index := make(map[id.ID]*Member, len(members))
	for i := range members {
		index[members[i].UserID] = &members[i]
	}
	type pair struct{ user, role id.ID }
	pairs, err := queryRows(ctx, s.r, func(r rowScanner) (pair, error) {
		var p pair
		err := r.Scan(&p.user, &p.role)
		return p, err
	}, `SELECT user_id, role_id FROM member_roles WHERE server_id = ?`, server)
	if err != nil {
		return nil, err
	}
	for _, p := range pairs {
		if m := index[p.user]; m != nil {
			m.Roles = append(m.Roles, p.role)
		}
	}
	return members, nil
}

// MemberPatch holds optional changes to a member.
type MemberPatch struct {
	Nick       *string  `json:"nick"`
	Roles      *[]id.ID `json:"roles"`
	ServerMute *bool    `json:"server_mute"`
	ServerDeaf *bool    `json:"server_deaf"`
}

// UpdateMember applies a patch.
func (s *Store) UpdateMember(ctx context.Context, server, user id.ID, p MemberPatch) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := checkAffected(tx.ExecContext(ctx, `UPDATE members SET nick = COALESCE(?, nick), server_mute = COALESCE(?, server_mute),
			server_deaf = COALESCE(?, server_deaf) WHERE server_id = ? AND user_id = ?`, p.Nick, p.ServerMute, p.ServerDeaf, server, user)); err != nil {
			return err
		}
		if p.Roles == nil {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM member_roles WHERE server_id = ? AND user_id = ?`, server, user); err != nil {
			return err
		}
		for _, role := range *p.Roles {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?,?,?)`, server, user, role); err != nil {
				return err
			}
		}
		return nil
	})
}

const roleCols = `id, server_id, meta, color, position, permissions, hoist, mentionable`

func scanRole(r rowScanner) (Role, error) {
	var v Role
	err := r.Scan(&v.ID, &v.ServerID, &v.Meta, &v.Color, &v.Position, &v.Permissions, &v.Hoist, &v.Mentionable)
	return v, err
}

// ListRoles returns a server's roles, lowest first.
func (s *Store) ListRoles(ctx context.Context, server id.ID) ([]Role, error) {
	return queryRows(ctx, s.r, scanRole, `SELECT `+roleCols+` FROM roles WHERE server_id = ? ORDER BY position, id`, server)
}

// CreateRole adds a role directly above the base role.
func (s *Store) CreateRole(ctx context.Context, r Role) (Role, error) {
	r.ID = s.IDs.Next()
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE roles SET position = position + 1 WHERE server_id = ? AND position >= 1`, r.ServerID); err != nil {
			return err
		}
		r.Position = 1
		_, err := tx.ExecContext(ctx, `INSERT INTO roles (id, server_id, meta, color, position, permissions, hoist, mentionable) VALUES (?,?,?,?,?,?,?,?)`,
			r.ID, r.ServerID, r.Meta, r.Color, r.Position, r.Permissions, r.Hoist, r.Mentionable)
		return err
	})
	return r, err
}

// RolePatch holds optional changes to a role.
type RolePatch struct {
	Meta        *string    `json:"meta"`
	Color       *int       `json:"color"`
	Permissions *perm.Perm `json:"permissions"`
	Hoist       *bool      `json:"hoist"`
	Mentionable *bool      `json:"mentionable"`
}

// UpdateRole applies a patch.
func (s *Store) UpdateRole(ctx context.Context, role id.ID, p RolePatch) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE roles SET meta = COALESCE(?, meta), color = COALESCE(?, color),
		permissions = COALESCE(?, permissions), hoist = COALESCE(?, hoist), mentionable = COALESCE(?, mentionable) WHERE id = ?`,
		p.Meta, p.Color, p.Permissions, p.Hoist, p.Mentionable, role))
}

// SetRolePositions rewrites role order. order lists role IDs lowest first and
// positions start at startPosition.
func (s *Store) SetRolePositions(ctx context.Context, server id.ID, order []id.ID, startPosition int) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		for i, role := range order {
			if _, err := tx.ExecContext(ctx, `UPDATE roles SET position = ? WHERE id = ? AND server_id = ?`, startPosition+i, role, server); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteRole removes a role and any overwrites that targeted it.
func (s *Store) DeleteRole(ctx context.Context, role id.ID) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM overwrites WHERE is_member = 0 AND target_id = ?`, role); err != nil {
			return err
		}
		return checkAffected(tx.ExecContext(ctx, `DELETE FROM roles WHERE id = ?`, role))
	})
}

// ServerChannels lists every channel of a server with its overwrites.
func (s *Store) ServerChannels(ctx context.Context, server id.ID) ([]Channel, error) {
	channels, err := queryRows(ctx, s.r, scanChannel, `SELECT `+channelCols+` FROM channels WHERE server_id = ? ORDER BY position, id`, server)
	if err != nil {
		return nil, err
	}
	overwrites, err := s.serverOverwrites(ctx, server)
	if err != nil {
		return nil, err
	}
	for i := range channels {
		channels[i].Overwrites = overwrites[channels[i].ID]
	}
	return channels, nil
}

func (s *Store) serverOverwrites(ctx context.Context, server id.ID) (map[id.ID][]Overwrite, error) {
	list, err := queryRows(ctx, s.r, func(r rowScanner) (Overwrite, error) {
		var o Overwrite
		err := r.Scan(&o.ChannelID, &o.Member, &o.TargetID, &o.Allow, &o.Deny)
		return o, err
	}, `SELECT o.channel_id, o.is_member, o.target_id, o.allow, o.deny FROM overwrites o
		JOIN channels c ON c.id = o.channel_id WHERE c.server_id = ?`, server)
	if err != nil {
		return nil, err
	}
	out := map[id.ID][]Overwrite{}
	for _, o := range list {
		out[o.ChannelID] = append(out[o.ChannelID], o)
	}
	return out, nil
}

// GetChannel fetches one channel without its overwrites.
func (s *Store) GetChannel(ctx context.Context, channel id.ID) (Channel, error) {
	c, err := scanChannel(s.r.QueryRowContext(ctx, `SELECT `+channelCols+` FROM channels WHERE id = ?`, channel))
	return c, notFound(err)
}

// GetChannelFresh reads a channel through the writer, so the result reflects
// a write made a moment ago.
func (s *Store) GetChannelFresh(ctx context.Context, channel id.ID) (Channel, error) {
	c, err := scanChannel(s.w.QueryRowContext(ctx, `SELECT `+channelCols+` FROM channels WHERE id = ?`, channel))
	return c, notFound(err)
}

// CreateChannel adds a channel at the end of its group.
func (s *Store) CreateChannel(ctx context.Context, c Channel) (Channel, error) {
	c.ID = s.IDs.Next()
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(position) + 1, 0) FROM channels WHERE server_id = ? AND parent_id = ?`,
			c.ServerID, c.ParentID).Scan(&c.Position); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO channels (id, server_id, kind, meta, position, parent_id, owner_id, user_limit, ttl_seconds, created_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`, c.ID, c.ServerID, c.Kind, c.Meta, c.Position, c.ParentID, c.OwnerID, c.UserLimit, c.TTLSeconds, now())
		return err
	})
	return c, err
}

// ChannelPatch holds optional changes to a channel.
type ChannelPatch struct {
	Meta       *string `json:"meta"`
	ParentID   *id.ID  `json:"parent_id"`
	UserLimit  *int    `json:"user_limit"`
	TTLSeconds *int    `json:"ttl_seconds"`
}

// UpdateChannel applies a patch.
func (s *Store) UpdateChannel(ctx context.Context, channel id.ID, p ChannelPatch) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE channels SET meta = COALESCE(?, meta), parent_id = COALESCE(?, parent_id),
		user_limit = COALESCE(?, user_limit), ttl_seconds = COALESCE(?, ttl_seconds) WHERE id = ?`,
		p.Meta, p.ParentID, p.UserLimit, p.TTLSeconds, channel))
}

// ChannelPlacement is one entry of a reorder request.
type ChannelPlacement struct {
	ID       id.ID `json:"id"`
	ParentID id.ID `json:"parent_id"`
	Position int   `json:"position"`
}

// PlaceChannels applies a batch of position changes.
func (s *Store) PlaceChannels(ctx context.Context, server id.ID, list []ChannelPlacement) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, c := range list {
			if _, err := tx.ExecContext(ctx, `UPDATE channels SET parent_id = ?, position = ? WHERE id = ? AND server_id = ?`,
				c.ParentID, c.Position, c.ID, server); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteChannel removes a channel. Children of a category move to the top
// level. It returns the attachments whose files must be removed from disk.
func (s *Store) DeleteChannel(ctx context.Context, channel id.ID) ([]id.ID, error) {
	var files []id.ID
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		files, err = collectIDs(ctx, tx, `SELECT a.id FROM attachments a JOIN messages m ON a.message_id = m.id WHERE m.channel_id = ?`, channel)
		if err != nil {
			return err
		}
		if err := deleteAttachments(ctx, tx, files); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE channels SET parent_id = 0 WHERE parent_id = ?`, channel); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE servers SET system_channel_id = 0 WHERE system_channel_id = ?`, channel); err != nil {
			return err
		}
		return checkAffected(tx.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, channel))
	})
	return files, err
}

// SetOverwrite creates or replaces one channel overwrite.
func (s *Store) SetOverwrite(ctx context.Context, o Overwrite) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO overwrites (channel_id, is_member, target_id, allow, deny) VALUES (?,?,?,?,?)
		ON CONFLICT (channel_id, is_member, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
		o.ChannelID, o.Member, o.TargetID, o.Allow, o.Deny)
	return err
}

// DeleteOverwrite removes one channel overwrite.
func (s *Store) DeleteOverwrite(ctx context.Context, channel id.ID, member bool, target id.ID) error {
	return checkAffected(s.w.ExecContext(ctx, `DELETE FROM overwrites WHERE channel_id = ? AND is_member = ? AND target_id = ?`, channel, member, target))
}

// Snapshot assembles a server's permission data.
func (s *Store) Snapshot(ctx context.Context, server id.ID) (*perm.Snapshot, error) {
	srv, err := s.GetServer(ctx, server)
	if err != nil {
		return nil, err
	}
	roles, err := s.ListRoles(ctx, server)
	if err != nil {
		return nil, err
	}
	members, err := s.ListMembers(ctx, server)
	if err != nil {
		return nil, err
	}
	overwrites, err := s.serverOverwrites(ctx, server)
	if err != nil {
		return nil, err
	}
	type link struct{ channel, parent id.ID }
	links, err := queryRows(ctx, s.r, func(r rowScanner) (link, error) {
		var l link
		err := r.Scan(&l.channel, &l.parent)
		return l, err
	}, `SELECT id, parent_id FROM channels WHERE server_id = ? AND parent_id != 0`, server)
	if err != nil {
		return nil, err
	}
	snap := &perm.Snapshot{
		ServerID:   server,
		OwnerID:    srv.OwnerID,
		Roles:      make(map[id.ID]perm.Role, len(roles)),
		Members:    make(map[id.ID][]id.ID, len(members)),
		Overwrites: make(map[id.ID][]perm.Overwrite, len(overwrites)),
		Parents:    make(map[id.ID]id.ID, len(links)),
	}
	for _, r := range roles {
		snap.Roles[r.ID] = perm.Role{ID: r.ID, Position: r.Position, Perms: r.Permissions}
	}
	for _, m := range members {
		snap.Members[m.UserID] = m.Roles
	}
	for channel, list := range overwrites {
		for _, o := range list {
			snap.Overwrites[channel] = append(snap.Overwrites[channel], perm.Overwrite{Member: o.Member, Target: o.TargetID, Allow: o.Allow, Deny: o.Deny})
		}
	}
	for _, l := range links {
		snap.Parents[l.channel] = l.parent
	}
	return snap, nil
}

// Invite grants entry to a server.
type Invite struct {
	Code      string `json:"code"`
	ServerID  id.ID  `json:"server_id"`
	ChannelID id.ID  `json:"channel_id"`
	CreatorID id.ID  `json:"creator_id"`
	Uses      int    `json:"uses"`
	MaxUses   int    `json:"max_uses"`
	ExpiresAt int64  `json:"expires_at"`
	CreatedAt int64  `json:"created_at"`
}

const inviteCols = `code, server_id, channel_id, creator_id, uses, max_uses, expires_at, created_at`

func scanInvite(r rowScanner) (Invite, error) {
	var v Invite
	err := r.Scan(&v.Code, &v.ServerID, &v.ChannelID, &v.CreatorID, &v.Uses, &v.MaxUses, &v.ExpiresAt, &v.CreatedAt)
	return v, err
}

// CreateInvite stores a new invite.
func (s *Store) CreateInvite(ctx context.Context, v Invite) (Invite, error) {
	v.CreatedAt = now()
	_, err := s.w.ExecContext(ctx, `INSERT INTO invites (code, server_id, channel_id, creator_id, max_uses, expires_at, created_at) VALUES (?,?,?,?,?,?,?)`,
		v.Code, v.ServerID, v.ChannelID, v.CreatorID, v.MaxUses, v.ExpiresAt, v.CreatedAt)
	if isUnique(err) {
		return v, ErrConflict
	}
	return v, err
}

// GetInvite fetches an invite whether or not it is still usable.
func (s *Store) GetInvite(ctx context.Context, code string) (Invite, error) {
	v, err := scanInvite(s.r.QueryRowContext(ctx, `SELECT `+inviteCols+` FROM invites WHERE code = ?`, code))
	return v, notFound(err)
}

// Usable reports whether the invite can still admit someone.
func (v Invite) Usable() bool {
	if v.ExpiresAt != 0 && v.ExpiresAt < now() {
		return false
	}
	return v.MaxUses == 0 || v.Uses < v.MaxUses
}

// ListInvites returns a server's invites.
func (s *Store) ListInvites(ctx context.Context, server id.ID) ([]Invite, error) {
	return queryRows(ctx, s.r, scanInvite, `SELECT `+inviteCols+` FROM invites WHERE server_id = ? ORDER BY created_at DESC`, server)
}

// DeleteInvite revokes an invite.
func (s *Store) DeleteInvite(ctx context.Context, code string) error {
	return checkAffected(s.w.ExecContext(ctx, `DELETE FROM invites WHERE code = ?`, code))
}

// RedeemInvite atomically consumes one use of an invite and admits the user.
func (s *Store) RedeemInvite(ctx context.Context, code string, user id.ID) (Invite, error) {
	var v Invite
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		v, err = scanInvite(tx.QueryRowContext(ctx, `SELECT `+inviteCols+` FROM invites WHERE code = ?`, code))
		if err != nil {
			return notFound(err)
		}
		if !v.Usable() {
			return ErrGone
		}
		var banned int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM bans WHERE server_id = ? AND user_id = ?`, v.ServerID, user).Scan(&banned); err != nil {
			return err
		}
		if banned > 0 {
			return ErrBanned
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO members (server_id, user_id, joined_at) VALUES (?,?,?)`, v.ServerID, user, now())
		if isUnique(err) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		v.Uses++
		_, err = tx.ExecContext(ctx, `UPDATE invites SET uses = uses + 1 WHERE code = ?`, code)
		return err
	})
	return v, err
}

// ErrBanned is returned when a banned user tries to join.
var ErrBanned = fmt.Errorf("banned from this server")

// Ban records a user's exclusion from a server.
type Ban struct {
	UserID    id.ID  `json:"user_id"`
	Reason    string `json:"reason,omitempty"`
	BannedBy  id.ID  `json:"banned_by"`
	CreatedAt int64  `json:"created_at"`
}

// BanUser removes a member if present and blocks them from returning.
func (s *Store) BanUser(ctx context.Context, server, user, by id.ID, reason string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM server_keys WHERE server_id = ? AND user_id = ?`, server, user); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM members WHERE server_id = ? AND user_id = ?`, server, user); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO bans (server_id, user_id, reason, banned_by, created_at) VALUES (?,?,?,?,?)
			ON CONFLICT (server_id, user_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by`,
			server, user, reason, by, now())
		return err
	})
}

// Unban lifts a ban.
func (s *Store) Unban(ctx context.Context, server, user id.ID) error {
	return checkAffected(s.w.ExecContext(ctx, `DELETE FROM bans WHERE server_id = ? AND user_id = ?`, server, user))
}

// ListBans returns a server's bans.
func (s *Store) ListBans(ctx context.Context, server id.ID) ([]Ban, error) {
	return queryRows(ctx, s.r, func(r rowScanner) (Ban, error) {
		var v Ban
		err := r.Scan(&v.UserID, &v.Reason, &v.BannedBy, &v.CreatedAt)
		return v, err
	}, `SELECT user_id, reason, banned_by, created_at FROM bans WHERE server_id = ? ORDER BY created_at DESC`, server)
}

// AuditEntry records one moderation or configuration action.
type AuditEntry struct {
	ID       id.ID  `json:"id"`
	ActorID  id.ID  `json:"actor_id"`
	Action   string `json:"action"`
	TargetID id.ID  `json:"target_id"`
	Detail   string `json:"detail,omitempty"`
}

// Audit appends to a server's audit log.
func (s *Store) Audit(ctx context.Context, server, actor id.ID, action string, target id.ID, detail string) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO audit_log (id, server_id, actor_id, action, target_id, detail) VALUES (?,?,?,?,?,?)`,
		s.IDs.Next(), server, actor, action, target, detail)
	return err
}

// ListAudit returns recent audit entries, newest first.
func (s *Store) ListAudit(ctx context.Context, server id.ID, limit int) ([]AuditEntry, error) {
	return queryRows(ctx, s.r, func(r rowScanner) (AuditEntry, error) {
		var v AuditEntry
		err := r.Scan(&v.ID, &v.ActorID, &v.Action, &v.TargetID, &v.Detail)
		return v, err
	}, `SELECT id, actor_id, action, target_id, detail FROM audit_log WHERE server_id = ? ORDER BY id DESC LIMIT ?`, server, limit)
}

// UserDMs lists the DM and group channels visible to a user.
func (s *Store) UserDMs(ctx context.Context, user id.ID) ([]Channel, error) {
	channels, err := queryRows(ctx, s.r, scanChannel, `SELECT `+channelCols+` FROM channels WHERE id IN
		(SELECT channel_id FROM dm_participants WHERE user_id = ? AND hidden = 0) ORDER BY last_message_id DESC, id DESC`, user)
	if err != nil {
		return nil, err
	}
	for i := range channels {
		if channels[i].Recipients, err = s.DMParticipants(ctx, channels[i].ID); err != nil {
			return nil, err
		}
	}
	return channels, nil
}

// DMParticipants lists everyone in a private channel.
func (s *Store) DMParticipants(ctx context.Context, channel id.ID) ([]id.ID, error) {
	return queryRows(ctx, s.r, scanID, `SELECT user_id FROM dm_participants WHERE channel_id = ?`, channel)
}

// IsDMParticipant reports whether a user belongs to a private channel.
func (s *Store) IsDMParticipant(ctx context.Context, channel, user id.ID) (bool, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM dm_participants WHERE channel_id = ? AND user_id = ?`, channel, user).Scan(&n)
	return n > 0, err
}

// FindDM returns the existing one-to-one channel between two users.
func (s *Store) FindDM(ctx context.Context, a, b id.ID) (id.ID, error) {
	var channel id.ID
	err := s.r.QueryRowContext(ctx, `SELECT c.id FROM channels c
		JOIN dm_participants p1 ON p1.channel_id = c.id AND p1.user_id = ?
		JOIN dm_participants p2 ON p2.channel_id = c.id AND p2.user_id = ?
		WHERE c.kind = 'dm' LIMIT 1`, a, b).Scan(&channel)
	return channel, notFound(err)
}

// CreateDM makes a private channel. Two participants form a DM, more a group.
func (s *Store) CreateDM(ctx context.Context, owner id.ID, participants []id.ID) (Channel, error) {
	kind := KindDM
	if len(participants) > 2 {
		kind = KindGroup
	}
	c := Channel{ID: s.IDs.Next(), Kind: kind, OwnerID: owner, Recipients: participants}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO channels (id, kind, owner_id, created_at) VALUES (?,?,?,?)`,
			c.ID, kind, owner, now()); err != nil {
			return err
		}
		for _, p := range participants {
			if _, err := tx.ExecContext(ctx, `INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)`, c.ID, p); err != nil {
				return err
			}
		}
		return nil
	})
	return c, err
}

// SetDMHidden shows or hides a DM in one user's list.
func (s *Store) SetDMHidden(ctx context.Context, channel, user id.ID, hidden bool) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE dm_participants SET hidden = ? WHERE channel_id = ? AND user_id = ?`, hidden, channel, user))
}

// UnhideDM makes a channel reappear for everyone, as when a message arrives.
func (s *Store) UnhideDM(ctx context.Context, channel id.ID) ([]id.ID, error) {
	hidden, err := queryRows(ctx, s.r, scanID, `SELECT user_id FROM dm_participants WHERE channel_id = ? AND hidden = 1`, channel)
	if err != nil || len(hidden) == 0 {
		return nil, err
	}
	_, err = s.w.ExecContext(ctx, `UPDATE dm_participants SET hidden = 0 WHERE channel_id = ?`, channel)
	return hidden, err
}
