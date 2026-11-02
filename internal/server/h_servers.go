package server

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"time"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/store"
)

// requireServer loads the caller's permission view of a server, or reports
// not-found to non-members so server IDs cannot be probed.
func (s *Server) requireServer(ctx context.Context, server, user id.ID) (*perm.Snapshot, perm.Perm, error) {
	snap, err := s.snapshot(ctx, server)
	if err != nil {
		return nil, 0, err
	}
	if !snap.IsMember(user) {
		return nil, 0, errNotFound
	}
	return snap, snap.Base(user), nil
}

func (s *Server) audit(ctx context.Context, server, actor id.ID, action string, target id.ID, detail string) {
	if err := s.db.Audit(ctx, server, actor, action, target, detail); err != nil {
		slog.Warn("writing audit log", "err", err)
	}
}

const (
	maxTemplateRoles    = 10
	maxTemplateChannels = 40
)

func (s *Server) createServer(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var body struct {
		Meta     string             `json:"meta"`
		Roles    []store.NewRole    `json:"roles"`
		Channels []store.NewChannel `json:"channels"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	if err := checkMeta("meta", body.Meta, false); err != nil {
		return err
	}
	if len(body.Roles) == 0 || len(body.Roles) > maxTemplateRoles || len(body.Channels) > maxTemplateChannels {
		return fail(http.StatusBadRequest, "bad_template", "A server needs 1 to 10 roles and at most 40 channels.")
	}
	for _, role := range body.Roles {
		if err := checkMeta("role", role.Meta, false); err != nil {
			return err
		}
	}
	for i, c := range body.Channels {
		switch c.Kind {
		case store.KindText, store.KindVoice, store.KindCategory:
		default:
			return fail(http.StatusBadRequest, "bad_template", "Unknown channel kind.")
		}
		if err := checkMeta("channel", c.Meta, false); err != nil {
			return err
		}
		if c.Parent >= i || c.Parent < -1 || (c.Parent >= 0 && body.Channels[c.Parent].Kind != store.KindCategory) ||
			(c.Kind == store.KindCategory && c.Parent != -1) || c.UserLimit < 0 || c.UserLimit > 99 {
			return fail(http.StatusBadRequest, "bad_template", "The channel layout is invalid.")
		}
	}
	ctx := r.Context()
	srv, err := s.db.CreateServer(ctx, store.NewServer{OwnerID: auth.User, Meta: body.Meta, Roles: body.Roles, Channels: body.Channels})
	if err != nil {
		return err
	}
	st, err := s.serverStateFor(ctx, srv.ID, auth.User)
	if err != nil {
		return err
	}
	s.hub.send([]id.ID{auth.User}, "server.sync", st)
	writeJSON(w, http.StatusCreated, st)
	return nil
}

func (s *Server) patchServer(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	var p store.ServerPatch
	if err := decode(r, w, &p); err != nil {
		return err
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageServer) {
		return errForbidden
	}
	if p.Meta != nil {
		if err := checkMeta("meta", *p.Meta, false); err != nil {
			return err
		}
	}
	if p.IconAttachment != nil && *p.IconAttachment != 0 {
		a, err := s.db.GetAttachment(ctx, *p.IconAttachment)
		if err != nil || a.Kind != "server" || a.ServerID != server {
			return fail(http.StatusBadRequest, "bad_image", "That image cannot be used.")
		}
	}
	if p.SystemChannelID != nil && *p.SystemChannelID != 0 {
		c, err := s.db.GetChannel(ctx, *p.SystemChannelID)
		if err != nil || c.ServerID != server || c.Kind != store.KindText {
			return fail(http.StatusBadRequest, "bad_channel", "That channel cannot receive system messages.")
		}
	}
	if p.OwnerID != nil {
		if auth.User != snap.OwnerID {
			return fail(http.StatusForbidden, "owner_only", "Only the owner can transfer ownership.")
		}
		if !snap.IsMember(*p.OwnerID) {
			return fail(http.StatusBadRequest, "not_member", "The new owner must be a member.")
		}
	}
	if err := s.db.UpdateServer(ctx, server, p); err != nil {
		return err
	}
	s.invalidate(server)
	s.audit(ctx, server, auth.User, "server.update", server, "")
	s.syncServer(ctx, server)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteServer(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	ctx := r.Context()
	snap, _, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if auth.User != snap.OwnerID {
		return fail(http.StatusForbidden, "owner_only", "Only the owner can delete a server.")
	}
	channels, err := s.db.ServerChannels(ctx, server)
	if err != nil {
		return err
	}
	for _, c := range channels {
		if c.Kind == store.KindVoice {
			s.voice.clearChannel(ctx, c.ID)
		}
	}
	members := snap.MemberIDs()
	files, err := s.db.DeleteServer(ctx, server)
	if err != nil {
		return err
	}
	s.invalidate(server)
	s.removeFiles(files)
	s.hub.send(members, "server.remove", map[string]any{"server_id": server})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) leaveServer(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	ctx := r.Context()
	snap, _, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if auth.User == snap.OwnerID {
		return fail(http.StatusBadRequest, "owner_cannot_leave", "Transfer ownership first, or delete the server.")
	}
	if err := s.removeMember(ctx, server, auth.User); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// removeMember drops a member and tells everyone who needs to know.
func (s *Server) removeMember(ctx context.Context, server, user id.ID) error {
	if err := s.db.RemoveMember(ctx, server, user); err != nil {
		return err
	}
	s.departed(ctx, server, user)
	return nil
}

// departed announces that a user no longer belongs to a server. Their old
// channel keys stay valid only until the next message forces a new generation.
func (s *Server) departed(ctx context.Context, server, user id.ID) {
	s.voice.removeFromServer(ctx, server, user)
	s.invalidate(server)
	s.hub.send([]id.ID{user}, "server.remove", map[string]any{"server_id": server})
	s.toServer(ctx, server, "member.remove", map[string]any{"server_id": server, "user_id": user})
	s.voice.rotateActiveCalls(ctx, server)
}

// memberJoined announces a new member, posts the greeting and asks key
// holders to share with them.
func (s *Server) memberJoined(ctx context.Context, server, user id.ID) {
	s.invalidate(server)
	member, err := s.db.GetMember(ctx, server, user)
	if err != nil {
		slog.Warn("loading new member", "err", err)
		return
	}
	u, err := s.db.GetUser(ctx, user)
	if err != nil {
		slog.Warn("loading new member", "err", err)
		return
	}
	s.toServer(ctx, server, "member.add", map[string]any{"member": member, "user": u, "status": s.hub.presence(user)})
	st, err := s.serverStateFor(ctx, server, user)
	if err != nil {
		slog.Warn("loading joined server", "err", err)
		return
	}
	s.sendServerUsers(ctx, user, st)
	defer s.requestMissingKeys(ctx, server)
	srv, err := s.db.GetServer(ctx, server)
	if err != nil || srv.SystemChannelID == 0 {
		return
	}
	c, err := s.db.GetChannel(ctx, srv.SystemChannelID)
	if err != nil {
		return
	}
	message, err := s.db.CreateMessage(ctx, store.NewMessage{ChannelID: c.ID, AuthorID: user, Kind: "join", TTL: time.Duration(c.TTLSeconds) * time.Second})
	if err != nil {
		slog.Warn("posting join message", "err", err)
		return
	}
	s.toChannel(ctx, c, "message.create", message)
}

// sendServerUsers delivers a server to a new member along with the profiles
// they have never seen.
func (s *Server) sendServerUsers(ctx context.Context, user id.ID, st ServerState) {
	ids := make([]id.ID, len(st.Members))
	for i, m := range st.Members {
		ids[i] = m.UserID
	}
	users, err := s.db.UsersByID(ctx, ids)
	if err != nil {
		slog.Warn("loading members", "err", err)
		return
	}
	s.hub.send([]id.ID{user}, "users.add", map[string]any{"users": orEmpty(users), "presences": s.hub.presences(ids)})
	s.hub.send([]id.ID{user}, "server.sync", st)
}

func (s *Server) patchMember(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	target, err := pathID(r, "user")
	if err != nil {
		return err
	}
	var p store.MemberPatch
	if err := decode(r, w, &p); err != nil {
		return err
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !snap.IsMember(target) {
		return errNotFound
	}
	self := target == auth.User
	outranks := snap.Outranks(auth.User, target)

	if p.Nick != nil {
		switch {
		case self && base.Has(perm.ChangeNickname):
		case !self && base.Has(perm.ManageNicknames) && outranks:
		case self && base.Has(perm.ManageNicknames):
		default:
			return errForbidden
		}
		v, err := cleanLine("nick", *p.Nick, 0, 32)
		if err != nil {
			return err
		}
		p.Nick = &v
	}
	if p.Roles != nil {
		if !base.Has(perm.ManageRoles) || (!self && !outranks) {
			return errForbidden
		}
		current := setOf(snap.Members[target])
		wanted := map[id.ID]bool{}
		for _, role := range *p.Roles {
			if _, exists := snap.Roles[role]; !exists || role == server {
				return fail(http.StatusBadRequest, "bad_role", "Unknown role.")
			}
			wanted[role] = true
		}
		// Only roles actually being added or removed need authority over
		// them: a moderator may edit someone's lower roles even if that
		// person also holds a role above the moderator's reach.
		for role := range wanted {
			if !current[role] && !snap.CanManageRole(auth.User, role) {
				return errForbidden
			}
		}
		for role := range current {
			if !wanted[role] && !snap.CanManageRole(auth.User, role) {
				return errForbidden
			}
		}
	}
	if p.ServerMute != nil && (!base.Has(perm.VoiceMuteOthers) || (!self && !outranks)) {
		return errForbidden
	}
	if p.ServerDeaf != nil && (!base.Has(perm.VoiceDeafenOthers) || (!self && !outranks)) {
		return errForbidden
	}
	if err := s.db.UpdateMember(ctx, server, target, p); err != nil {
		return err
	}
	if p.Roles != nil {
		s.invalidate(server)
		s.audit(ctx, server, auth.User, "member.roles", target, "")
	}
	if p.ServerMute != nil || p.ServerDeaf != nil {
		s.voice.moderate(ctx, server, target, p.ServerMute, p.ServerDeaf)
		s.audit(ctx, server, auth.User, "member.voice", target, "")
	}
	member, err := s.db.GetMember(ctx, server, target)
	if err != nil {
		return err
	}
	s.toServer(ctx, server, "member.update", member)
	if p.Roles != nil {
		s.syncServer(ctx, server)
	}
	writeJSON(w, http.StatusOK, member)
	return nil
}

func (s *Server) kickMember(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	target, err := pathID(r, "user")
	if err != nil {
		return err
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !snap.IsMember(target) {
		return errNotFound
	}
	if !base.Has(perm.KickMembers) || !snap.Outranks(auth.User, target) {
		return errForbidden
	}
	if err := s.removeMember(ctx, server, target); err != nil {
		return err
	}
	s.audit(ctx, server, auth.User, "member.kick", target, "")
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listBans(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	ctx := r.Context()
	_, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.BanMembers) {
		return errForbidden
	}
	bans, err := s.db.ListBans(ctx, server)
	if err != nil {
		return err
	}
	ids := make([]id.ID, len(bans))
	for i, b := range bans {
		ids[i] = b.UserID
	}
	users, err := s.db.UsersByID(ctx, ids)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"bans": orEmpty(bans), "users": orEmpty(users)})
	return nil
}

func (s *Server) banMember(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	target, err := pathID(r, "user")
	if err != nil {
		return err
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	reason, err := cleanLine("reason", body.Reason, 0, 400)
	if err != nil {
		return err
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.BanMembers) || target == auth.User {
		return errForbidden
	}
	wasMember := snap.IsMember(target)
	if (wasMember && !snap.Outranks(auth.User, target)) || target == snap.OwnerID {
		return errForbidden
	}
	if _, err := s.db.GetUser(ctx, target); err != nil {
		return err
	}
	if err := s.db.BanUser(ctx, server, target, auth.User, reason); err != nil {
		return err
	}
	if wasMember {
		s.departed(ctx, server, target)
	}
	s.audit(ctx, server, auth.User, "member.ban", target, reason)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) unbanMember(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	target, err := pathID(r, "user")
	if err != nil {
		return err
	}
	ctx := r.Context()
	_, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.BanMembers) {
		return errForbidden
	}
	if err := s.db.Unban(ctx, server, target); err != nil {
		return err
	}
	s.audit(ctx, server, auth.User, "member.unban", target, "")
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) voiceDisconnect(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	target, err := pathID(r, "user")
	if err != nil {
		return err
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.VoiceMoveOthers) || !snap.Outranks(auth.User, target) {
		return errForbidden
	}
	if !s.voice.disconnect(ctx, server, target) {
		return errNotFound
	}
	s.audit(ctx, server, auth.User, "voice.disconnect", target, "")
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listAudit(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	ctx := r.Context()
	_, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ViewAudit) {
		return errForbidden
	}
	entries, err := s.db.ListAudit(ctx, server, queryInt(r, "limit", 100, 1, 500))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, orEmpty(entries))
	return nil
}

// grantable reports whether bits are all rights the actor holds. Nobody may
// hand out more authority than they have.
func grantable(snap *perm.Snapshot, actor id.ID, have, bits perm.Perm) bool {
	return actor == snap.OwnerID || have.Has(perm.Administrator) || have.Has(bits&perm.All)
}

func (s *Server) createRole(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	var body struct {
		Meta        string    `json:"meta"`
		Color       int       `json:"color"`
		Permissions perm.Perm `json:"permissions"`
		Hoist       bool      `json:"hoist"`
		Mentionable bool      `json:"mentionable"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	if err := checkMeta("role", body.Meta, false); err != nil {
		return err
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageRoles) || !grantable(snap, auth.User, base, body.Permissions) {
		return errForbidden
	}
	role, err := s.db.CreateRole(ctx, store.Role{
		ServerID: server, Meta: body.Meta, Color: body.Color & 0xFFFFFF,
		Permissions: body.Permissions & perm.All, Hoist: body.Hoist, Mentionable: body.Mentionable,
	})
	if err != nil {
		return err
	}
	s.invalidate(server)
	s.audit(ctx, server, auth.User, "role.create", role.ID, "")
	s.syncServer(ctx, server)
	writeJSON(w, http.StatusCreated, role)
	return nil
}

func (s *Server) patchRole(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	roleID, err := pathID(r, "role")
	if err != nil {
		return err
	}
	var p store.RolePatch
	if err := decode(r, w, &p); err != nil {
		return err
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if _, exists := snap.Roles[roleID]; !exists {
		return errNotFound
	}
	if !base.Has(perm.ManageRoles) || !snap.CanManageRole(auth.User, roleID) {
		return errForbidden
	}
	if p.Permissions != nil {
		// Bits the role already has may stay even if the editor lacks them;
		// only newly granted bits need the editor's authority.
		added := *p.Permissions &^ snap.Roles[roleID].Perms
		if !grantable(snap, auth.User, base, added) {
			return errForbidden
		}
		masked := *p.Permissions & perm.All
		p.Permissions = &masked
	}
	if p.Meta != nil {
		if err := checkMeta("role", *p.Meta, false); err != nil {
			return err
		}
	}
	if p.Color != nil {
		masked := *p.Color & 0xFFFFFF
		p.Color = &masked
	}
	if err := s.db.UpdateRole(ctx, roleID, p); err != nil {
		return err
	}
	s.invalidate(server)
	s.audit(ctx, server, auth.User, "role.update", roleID, "")
	s.syncServer(ctx, server)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteRole(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	roleID, err := pathID(r, "role")
	if err != nil {
		return err
	}
	if roleID == server {
		return fail(http.StatusBadRequest, "base_role", "The base role cannot be removed.")
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if _, exists := snap.Roles[roleID]; !exists {
		return errNotFound
	}
	if !base.Has(perm.ManageRoles) || !snap.CanManageRole(auth.User, roleID) {
		return errForbidden
	}
	if err := s.db.DeleteRole(ctx, roleID); err != nil {
		return err
	}
	s.invalidate(server)
	s.audit(ctx, server, auth.User, "role.delete", roleID, "")
	s.syncServer(ctx, server)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) orderRoles(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	var body struct {
		Roles []id.ID `json:"roles"` // lowest first, base role excluded
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	snap, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageRoles) {
		return errForbidden
	}
	if len(body.Roles) != len(snap.Roles)-1 {
		return fail(http.StatusBadRequest, "bad_order", "Every role must be listed exactly once.")
	}
	seen := map[id.ID]bool{}
	top := snap.TopPosition(auth.User)
	for i, role := range body.Roles {
		current, exists := snap.Roles[role]
		if !exists || role == server || seen[role] {
			return fail(http.StatusBadRequest, "bad_order", "Every role must be listed exactly once.")
		}
		seen[role] = true
		// A role may only move if it starts and ends below the actor. This
		// stops anyone climbing past their own rank.
		if position := i + 1; auth.User != snap.OwnerID && position != current.Position && (current.Position >= top || position >= top) {
			return errForbidden
		}
	}
	if err := s.db.SetRolePositions(ctx, server, body.Roles, 1); err != nil {
		return err
	}
	s.invalidate(server)
	s.audit(ctx, server, auth.User, "role.reorder", server, "")
	s.syncServer(ctx, server)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

const inviteAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func newInviteCode() (string, error) {
	var b strings.Builder
	limit := big.NewInt(int64(len(inviteAlphabet)))
	for range 10 {
		n, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", err
		}
		b.WriteByte(inviteAlphabet[n.Int64()])
	}
	return b.String(), nil
}

func (s *Server) createInvite(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.CreateInvites)
	if err != nil {
		return err
	}
	if c.IsPrivate() {
		return errForbidden
	}
	var body struct {
		MaxAgeSeconds int64 `json:"max_age"`
		MaxUses       int   `json:"max_uses"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	if body.MaxAgeSeconds < 0 || body.MaxUses < 0 {
		return fail(http.StatusBadRequest, "bad_invite", "Limits cannot be negative.")
	}
	ctx := r.Context()
	expires := int64(0)
	if body.MaxAgeSeconds > 0 {
		expires = time.Now().Add(time.Duration(body.MaxAgeSeconds) * time.Second).UnixMilli()
	}
	for range 5 {
		code, err := newInviteCode()
		if err != nil {
			return err
		}
		invite, err := s.db.CreateInvite(ctx, store.Invite{
			Code: code, ServerID: c.ServerID, ChannelID: c.ID, CreatorID: auth.User, MaxUses: body.MaxUses, ExpiresAt: expires,
		})
		if errors.Is(err, store.ErrConflict) {
			continue
		}
		if err != nil {
			return err
		}
		s.audit(ctx, c.ServerID, auth.User, "invite.create", 0, code)
		writeJSON(w, http.StatusCreated, invite)
		return nil
	}
	return fmt.Errorf("could not generate a unique invite code")
}

func (s *Server) listInvites(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	ctx := r.Context()
	_, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageServer) {
		return errForbidden
	}
	invites, err := s.db.ListInvites(ctx, server)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, orEmpty(invites))
	return nil
}

// getInvite previews an invite. The server's name is encrypted: only someone
// holding the key from the invite link's fragment can read it.
func (s *Server) getInvite(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	invite, err := s.db.GetInvite(ctx, r.PathValue("code"))
	if err != nil {
		return err
	}
	if !invite.Usable() {
		return store.ErrGone
	}
	srv, err := s.db.GetServer(ctx, invite.ServerID)
	if err != nil {
		return err
	}
	snap, err := s.snapshot(ctx, srv.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code":    invite.Code,
		"server":  map[string]any{"id": srv.ID, "meta": srv.Meta},
		"gate":    srv.GateMode,
		"members": len(snap.Members),
		"online":  len(s.hub.presences(snap.MemberIDs())),
	})
	return nil
}

func (s *Server) joinInvite(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var body struct {
		Password string `json:"password"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, w, &body); err != nil {
			return err
		}
	}
	ctx := r.Context()
	code := r.PathValue("code")
	invite, err := s.db.GetInvite(ctx, code)
	if err != nil {
		return err
	}
	snap, err := s.snapshot(ctx, invite.ServerID)
	if err != nil {
		return err
	}
	if snap.IsMember(auth.User) {
		// Already a member: treat the link as "open this server".
		writeJSON(w, http.StatusOK, map[string]any{"server_id": invite.ServerID, "channel_id": invite.ChannelID})
		return nil
	}
	if err := s.passGate(ctx, invite.ServerID, auth.User, body.Password); err != nil {
		return err
	}
	invite, err = s.db.RedeemInvite(ctx, code, auth.User)
	if err != nil {
		return err
	}
	s.memberJoined(ctx, invite.ServerID, auth.User)
	writeJSON(w, http.StatusOK, map[string]any{"server_id": invite.ServerID, "channel_id": invite.ChannelID})
	return nil
}

// Gate modes.
const (
	gateNone     = "none"
	gatePassword = "password"
	gateRotating = "rotating"
)

// passGate checks a server's entry requirement.
func (s *Server) passGate(ctx context.Context, server, user id.ID, given string) error {
	gate, err := s.db.GetGate(ctx, server)
	if err != nil {
		return err
	}
	if gate.Mode == gateNone || gate.Mode == "" {
		return nil
	}
	if !s.gateLimit.allow(user.String() + ":" + server.String()) {
		return errRate
	}
	wrong := fail(http.StatusForbidden, "gate_failed", "That is not the password for this server.")
	if given == "" {
		return fail(http.StatusForbidden, "gate_required", "This server requires a password.")
	}
	switch gate.Mode {
	case gatePassword:
		ok, err := s.verifyPassword(ctx, given, gate.Hash)
		if err != nil {
			return err
		}
		if !ok {
			return wrong
		}
	case gateRotating:
		secret, err := s.secret.open(gate.Secret, "gate")
		if err != nil {
			return err
		}
		// Accept the code shown now and the one just before, so a code read
		// out at the last second still works.
		if _, ok := checkCode(secret, given, int64(gate.Period), 1, time.Now()); !ok {
			return wrong
		}
	}
	return nil
}

func (s *Server) getGate(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	ctx := r.Context()
	_, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageServer) && !base.Has(perm.CreateInvites) {
		return errForbidden
	}
	gate, err := s.db.GetGate(ctx, server)
	if err != nil {
		return err
	}
	resp := map[string]any{"mode": gate.Mode, "period": gate.Period}
	if gate.Mode == gateRotating {
		secret, err := s.secret.open(gate.Secret, "gate")
		if err != nil {
			return err
		}
		now := time.Now()
		period := int64(gate.Period)
		resp["code"] = hotp(secret, now.Unix()/period, totpDigits)
		resp["remaining"] = period - now.Unix()%period
	}
	writeJSON(w, http.StatusOK, resp)
	return nil
}

func (s *Server) putGate(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	var body struct {
		Mode     string `json:"mode"`
		Password string `json:"password"`
		Period   int    `json:"period"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	_, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageServer) {
		return errForbidden
	}
	gate := store.Gate{Mode: body.Mode, Period: 300}
	switch body.Mode {
	case gateNone:
	case gatePassword:
		if len([]rune(body.Password)) < 4 || len(body.Password) > 256 {
			return fail(http.StatusBadRequest, "bad_password", "Entry passwords need at least 4 characters.")
		}
		if gate.Hash, err = s.hashPassword(ctx, body.Password); err != nil {
			return err
		}
	case gateRotating:
		if body.Period < 30 || body.Period > 86400 {
			return fail(http.StatusBadRequest, "bad_period", "Codes can change every 30 seconds up to once a day.")
		}
		gate.Period = body.Period
		secret, err := newSecret()
		if err != nil {
			return err
		}
		if gate.Secret, err = s.secret.seal(secret, "gate"); err != nil {
			return err
		}
	default:
		return fail(http.StatusBadRequest, "bad_mode", "Unknown entry requirement.")
	}
	if err := s.db.SetGate(ctx, server, gate); err != nil {
		return err
	}
	s.audit(ctx, server, auth.User, "server.gate", server, body.Mode)
	s.syncServer(ctx, server)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteInvite(w http.ResponseWriter, r *http.Request, auth Auth) error {
	ctx := r.Context()
	code := r.PathValue("code")
	invite, err := s.db.GetInvite(ctx, code)
	if err != nil {
		return err
	}
	_, base, err := s.requireServer(ctx, invite.ServerID, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageServer) && invite.CreatorID != auth.User {
		return errForbidden
	}
	if err := s.db.DeleteInvite(ctx, code); err != nil {
		return err
	}
	s.audit(ctx, invite.ServerID, auth.User, "invite.delete", 0, code)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
