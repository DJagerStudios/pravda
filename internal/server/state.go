package server

import (
	"context"
	"log/slog"
	"time"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/store"
)

// ServerState is a server as one member sees it. Channels they cannot view
// are left out entirely.
type ServerState struct {
	store.Server
	Channels []store.Channel  `json:"channels"`
	Roles    []store.Role     `json:"roles"`
	Members  []store.Member   `json:"members"`
	Voice    []VoiceState     `json:"voice"`
	Perms    perm.Perm        `json:"perms"`
	Key      *store.SealedKey `json:"key,omitempty"` // this member's copy of the server key
}

// Ready is everything a client needs to draw itself.
type Ready struct {
	SessionID     string               `json:"session_id"`
	User          store.Account        `json:"user"`
	Instance      Instance             `json:"instance"`
	Servers       []ServerState        `json:"servers"`
	DMs           []store.Channel      `json:"dms"`
	Relationships []store.Relationship `json:"relationships"`
	ReadStates    []store.ReadState    `json:"read_states"`
	Users         []store.User         `json:"users"`
	Presences     map[id.ID]string     `json:"presences"`
	DMVoice       []VoiceState         `json:"dm_voice"`
	PendingKeys   []KeyRequest         `json:"pending_keys"`
	ServerTime    int64                `json:"server_time"`
}

// Instance describes this Pravda deployment.
type Instance struct {
	Name           string `json:"name"`
	Version        string `json:"version"`
	Registration   string `json:"registration"`
	Require2FA     bool   `json:"require_2fa"`
	MaxUploadBytes int64  `json:"max_upload_bytes"`
	FirstRun       bool   `json:"first_run"`
}

func (s *Server) instanceInfo(ctx context.Context) (Instance, error) {
	count, err := s.db.UserCount(ctx)
	return Instance{
		Name:           s.cfg.Name,
		Version:        Version,
		Registration:   s.cfg.Registration,
		Require2FA:     s.cfg.Require2FA,
		MaxUploadBytes: s.cfg.MaxUploadBytes,
		FirstRun:       count == 0,
	}, err
}

// serverStateFor filters a server down to what a member may see.
func (s *Server) serverStateFor(ctx context.Context, server id.ID, user id.ID) (ServerState, error) {
	srv, err := s.db.GetServer(ctx, server)
	if err != nil {
		return ServerState{}, err
	}
	snap, err := s.snapshot(ctx, server)
	if err != nil {
		return ServerState{}, err
	}
	all, err := s.db.ServerChannels(ctx, server)
	if err != nil {
		return ServerState{}, err
	}
	roles, err := s.db.ListRoles(ctx, server)
	if err != nil {
		return ServerState{}, err
	}
	members, err := s.db.ListMembers(ctx, server)
	if err != nil {
		return ServerState{}, err
	}
	base := snap.Base(user)
	seesOverwrites := base.Has(perm.ManageRoles) || base.Has(perm.ManageChannels)
	channels := make([]store.Channel, 0, len(all))
	visible := map[id.ID]bool{}
	for _, c := range all {
		c.Perms = snap.Channel(user, c.ID)
		if !c.Perms.Has(perm.ViewChannel) {
			continue
		}
		if !seesOverwrites {
			c.Overwrites = nil
		}
		channels = append(channels, c)
		visible[c.ID] = true
	}
	st := ServerState{
		Server:   srv,
		Channels: channels,
		Roles:    orEmpty(roles),
		Members:  orEmpty(members),
		Voice:    s.voice.statesIn(server, visible),
		Perms:    base,
	}
	if key, err := s.db.ServerKeyFor(ctx, server, user); err == nil {
		st.Key = &key
	}
	return st, nil
}

func (s *Server) buildReady(ctx context.Context, sn *Session, account store.Account) (*Ready, error) {
	user := sn.User
	info, err := s.instanceInfo(ctx)
	if err != nil {
		return nil, err
	}
	servers, err := s.db.UserServers(ctx, user)
	if err != nil {
		return nil, err
	}
	dms, err := s.db.UserDMs(ctx, user)
	if err != nil {
		return nil, err
	}
	relationships, err := s.db.Relationships(ctx, user)
	if err != nil {
		return nil, err
	}
	reads, err := s.db.ReadStates(ctx, user)
	if err != nil {
		return nil, err
	}
	for i := range dms {
		dms[i].Perms = dmPerms
	}
	// Empty lists must be sent as [] rather than null: clients iterate them.
	ready := &Ready{
		SessionID:     sn.ID,
		User:          account,
		Instance:      info,
		Servers:       make([]ServerState, 0, len(servers)),
		DMs:           orEmpty(dms),
		Relationships: orEmpty(relationships),
		ReadStates:    orEmpty(reads),
		DMVoice:       s.voice.dmStates(dms),
	}
	known := map[id.ID]bool{user: true}
	for _, srv := range servers {
		st, err := s.serverStateFor(ctx, srv.ID, user)
		if err != nil {
			return nil, err
		}
		ready.Servers = append(ready.Servers, st)
		for _, m := range st.Members {
			known[m.UserID] = true
		}
	}
	for _, c := range dms {
		for _, r := range c.Recipients {
			known[r] = true
		}
	}
	for _, r := range relationships {
		known[r.UserID] = true
	}
	ids := make([]id.ID, 0, len(known))
	for u := range known {
		ids = append(ids, u)
	}
	users, err := s.db.UsersByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	ready.Users = orEmpty(users)
	ready.Presences = s.hub.presences(ids)
	ready.PendingKeys = s.pendingKeyRequests(ctx, user, servers, dms)
	ready.ServerTime = time.Now().UnixMilli()
	return ready, nil
}

// orEmpty turns a nil slice into an empty one so it encodes as [].
func orEmpty[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}

// syncServer re-sends a server's state to its online members, each filtered
// to what they may see. Every structural change goes through this one path:
// a role edit can reveal or hide any number of channels, so sending per-user
// truth is simpler and safer than computing deltas.
func (s *Server) syncServer(ctx context.Context, server id.ID) {
	snap, err := s.snapshot(ctx, server)
	if err != nil {
		slog.Warn("syncing server", "server", server, "err", err)
		return
	}
	for _, user := range snap.MemberIDs() {
		if len(s.hub.userSessions(user)) == 0 {
			continue
		}
		st, err := s.serverStateFor(ctx, server, user)
		if err != nil {
			slog.Warn("syncing server", "server", server, "err", err)
			return
		}
		s.hub.send([]id.ID{user}, "server.sync", st)
	}
	s.voice.recheck(ctx, server)
	s.requestMissingKeys(ctx, server)
	s.voice.rotateActiveCalls(ctx, server)
}

// toServer sends an event to every member of a server.
func (s *Server) toServer(ctx context.Context, server id.ID, event string, data any) {
	snap, err := s.snapshot(ctx, server)
	if err != nil {
		slog.Warn("broadcasting to server", "server", server, "err", err)
		return
	}
	s.hub.send(snap.MemberIDs(), event, data)
}

// channelAudience lists who may see activity in a channel.
func (s *Server) channelAudience(ctx context.Context, c store.Channel) ([]id.ID, error) {
	if c.IsPrivate() {
		return s.db.DMParticipants(ctx, c.ID)
	}
	snap, err := s.snapshot(ctx, c.ServerID)
	if err != nil {
		return nil, err
	}
	return snap.Viewers(c.ID), nil
}

// toChannel sends an event to everyone who can see a channel.
func (s *Server) toChannel(ctx context.Context, c store.Channel, event string, data any) {
	audience, err := s.channelAudience(ctx, c)
	if err != nil {
		slog.Warn("broadcasting to channel", "channel", c.ID, "err", err)
		return
	}
	s.hub.send(audience, event, data)
}
