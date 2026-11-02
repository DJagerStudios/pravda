package server

import (
	"context"
	"net/http"
	"time"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/store"
)

// loadChannel fetches the channel named in the URL and checks the caller holds
// need. Channels the caller cannot see answer as missing, so their existence
// is not revealed.
func (s *Server) loadChannel(r *http.Request, auth Auth, need perm.Perm) (store.Channel, perm.Perm, error) {
	channel, err := pathID(r, "channel")
	if err != nil {
		return store.Channel{}, 0, err
	}
	ctx := r.Context()
	c, err := s.db.GetChannel(ctx, channel)
	if err != nil {
		return c, 0, err
	}
	perms, err := s.channelPerms(ctx, auth.User, c)
	if err != nil {
		return c, 0, err
	}
	if !perms.Has(perm.ViewChannel) {
		return c, 0, errNotFound
	}
	if !perms.Has(need) {
		return c, perms, errForbidden
	}
	return c, perms, nil
}

// validParent confirms a channel can sit inside the given category.
func (s *Server) validParent(ctx context.Context, server, parent id.ID) error {
	if parent == 0 {
		return nil
	}
	c, err := s.db.GetChannel(ctx, parent)
	if err != nil || c.ServerID != server || c.Kind != store.KindCategory {
		return fail(http.StatusBadRequest, "bad_parent", "That is not a category in this server.")
	}
	return nil
}

// allowedTTLs are the disappearing-message timers on offer, in seconds.
var allowedTTLs = map[int]bool{0: true, 300: true, 3600: true, 21600: true, 86400: true, 604800: true, 2592000: true}

func (s *Server) createChannel(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	var body struct {
		Meta       string `json:"meta"`
		Kind       string `json:"kind"`
		ParentID   id.ID  `json:"parent_id"`
		UserLimit  int    `json:"user_limit"`
		TTLSeconds int    `json:"ttl_seconds"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	_, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageChannels) {
		return errForbidden
	}
	switch body.Kind {
	case store.KindText, store.KindVoice:
	case store.KindCategory:
		body.ParentID = 0
	default:
		return fail(http.StatusBadRequest, "bad_kind", "Unknown channel kind.")
	}
	if err := checkMeta("channel", body.Meta, false); err != nil {
		return err
	}
	if body.UserLimit < 0 || body.UserLimit > 99 {
		return fail(http.StatusBadRequest, "bad_limit", "User limits run from 0 to 99.")
	}
	if !allowedTTLs[body.TTLSeconds] {
		return fail(http.StatusBadRequest, "bad_ttl", "Unsupported disappearing-message timer.")
	}
	if err := s.validParent(ctx, server, body.ParentID); err != nil {
		return err
	}
	c, err := s.db.CreateChannel(ctx, store.Channel{
		ServerID: server, Kind: body.Kind, Meta: body.Meta, ParentID: body.ParentID, UserLimit: body.UserLimit, TTLSeconds: body.TTLSeconds,
	})
	if err != nil {
		return err
	}
	s.invalidate(server)
	s.audit(ctx, server, auth.User, "channel.create", c.ID, "")
	s.syncServer(ctx, server)
	writeJSON(w, http.StatusCreated, c)
	return nil
}

func (s *Server) patchChannel(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, perms, err := s.loadChannel(r, auth, 0)
	if err != nil {
		return err
	}
	var p store.ChannelPatch
	if err := decode(r, w, &p); err != nil {
		return err
	}
	ctx := r.Context()
	if c.IsPrivate() {
		// In private conversations everyone shares control of the timer, and
		// of the name of a group.
		if p.ParentID != nil || p.UserLimit != nil || (p.Meta != nil && c.Kind != store.KindGroup) {
			return errForbidden
		}
	} else if !perms.Has(perm.ManageChannels) {
		return errForbidden
	}
	if p.Meta != nil {
		if err := checkMeta("channel", *p.Meta, c.IsPrivate()); err != nil {
			return err
		}
	}
	if p.ParentID != nil {
		if c.Kind == store.KindCategory {
			return fail(http.StatusBadRequest, "bad_parent", "Categories cannot be nested.")
		}
		if err := s.validParent(ctx, c.ServerID, *p.ParentID); err != nil {
			return err
		}
	}
	if p.UserLimit != nil && (*p.UserLimit < 0 || *p.UserLimit > 99) {
		return fail(http.StatusBadRequest, "bad_limit", "User limits run from 0 to 99.")
	}
	if p.TTLSeconds != nil && !allowedTTLs[*p.TTLSeconds] {
		return fail(http.StatusBadRequest, "bad_ttl", "Unsupported disappearing-message timer.")
	}
	if err := s.db.UpdateChannel(ctx, c.ID, p); err != nil {
		return err
	}
	if p.TTLSeconds != nil && *p.TTLSeconds != c.TTLSeconds {
		// Leave a visible note so nobody is surprised by vanishing messages.
		note, err := s.db.CreateMessage(ctx, store.NewMessage{
			ChannelID: c.ID, AuthorID: auth.User, Kind: "ttl", Content: itoa(*p.TTLSeconds),
			TTL: time.Duration(*p.TTLSeconds) * time.Second,
		})
		if err == nil {
			s.toChannel(ctx, c, "message.create", note)
		}
	}
	if c.IsPrivate() {
		full, err := s.dmChannel(ctx, c.ID)
		if err != nil {
			return err
		}
		s.hub.send(full.Recipients, "dm.create", s.dmEvent(ctx, full))
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	s.invalidate(c.ServerID)
	s.audit(ctx, c.ServerID, auth.User, "channel.update", c.ID, "")
	s.syncServer(ctx, c.ServerID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.ManageChannels)
	if err != nil {
		return err
	}
	if c.IsPrivate() {
		return errForbidden
	}
	ctx := r.Context()
	if c.Kind == store.KindVoice {
		s.voice.clearChannel(ctx, c.ID)
	}
	files, err := s.db.DeleteChannel(ctx, c.ID)
	if err != nil {
		return err
	}
	s.removeFiles(files)
	s.invalidate(c.ServerID)
	s.audit(ctx, c.ServerID, auth.User, "channel.delete", c.ID, "")
	s.syncServer(ctx, c.ServerID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) orderChannels(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	var body struct {
		Channels []store.ChannelPlacement `json:"channels"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	_, base, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	if !base.Has(perm.ManageChannels) {
		return errForbidden
	}
	for _, placement := range body.Channels {
		c, err := s.db.GetChannel(ctx, placement.ID)
		if err != nil || c.ServerID != server {
			return fail(http.StatusBadRequest, "bad_channel", "Unknown channel.")
		}
		if c.Kind == store.KindCategory && placement.ParentID != 0 {
			return fail(http.StatusBadRequest, "bad_parent", "Categories cannot be nested.")
		}
		if err := s.validParent(ctx, server, placement.ParentID); err != nil {
			return err
		}
	}
	if err := s.db.PlaceChannels(ctx, server, body.Channels); err != nil {
		return err
	}
	s.invalidate(server)
	s.syncServer(ctx, server)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func overwriteTarget(r *http.Request) (member bool, target id.ID, err error) {
	switch r.PathValue("kind") {
	case "role":
	case "member":
		member = true
	default:
		return false, 0, errNotFound
	}
	target, err = pathID(r, "target")
	return member, target, err
}

func (s *Server) putOverwrite(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, perms, err := s.loadChannel(r, auth, perm.ManageRoles)
	if err != nil {
		return err
	}
	if c.IsPrivate() {
		return errForbidden
	}
	member, target, err := overwriteTarget(r)
	if err != nil {
		return err
	}
	var body struct {
		Allow perm.Perm `json:"allow"`
		Deny  perm.Perm `json:"deny"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	snap, err := s.snapshot(ctx, c.ServerID)
	if err != nil {
		return err
	}
	if !grantable(snap, auth.User, perms, body.Allow|body.Deny) {
		return errForbidden
	}
	if member && !snap.IsMember(target) {
		return fail(http.StatusBadRequest, "bad_target", "Unknown user.")
	}
	if _, exists := snap.Roles[target]; !member && !exists {
		return fail(http.StatusBadRequest, "bad_target", "Unknown role.")
	}
	if err := s.db.SetOverwrite(ctx, store.Overwrite{
		ChannelID: c.ID, Member: member, TargetID: target, Allow: body.Allow & perm.All, Deny: body.Deny & perm.All,
	}); err != nil {
		return err
	}
	s.invalidate(c.ServerID)
	s.audit(ctx, c.ServerID, auth.User, "channel.overwrite", c.ID, "")
	s.syncServer(ctx, c.ServerID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteOverwrite(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.ManageRoles)
	if err != nil {
		return err
	}
	if c.IsPrivate() {
		return errForbidden
	}
	member, target, err := overwriteTarget(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.db.DeleteOverwrite(ctx, c.ID, member, target); err != nil {
		return err
	}
	s.invalidate(c.ServerID)
	s.audit(ctx, c.ServerID, auth.User, "channel.overwrite", c.ID, "")
	s.syncServer(ctx, c.ServerID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
