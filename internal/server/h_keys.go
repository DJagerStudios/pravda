package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/store"
)

// Key distribution. Every text and voice channel, DM and group has a
// symmetric key; every server has one more for its names. Keys are made by
// clients and travel only sealed to one recipient's identity key. The server
// decides who should hold a key (from permissions) and brokers the sharing,
// but holds nothing it could use.
//
// When someone gains access, members who already hold the key are asked to
// seal it for them. When someone loses access, the next message cannot be
// sent until a member starts a new key generation that excludes them.

// KeyRequest asks key holders to share with the listed users.
type KeyRequest struct {
	Scope   string  `json:"scope"` // "channel" or "server"
	ID      id.ID   `json:"id"`
	UserIDs []id.ID `json:"user_ids"`
	Epochs  []int   `json:"epochs,omitempty"`
	History bool    `json:"history,omitempty"`
}

type sealedInput struct {
	UserID  id.ID  `json:"user_id"`
	Wrapped string `json:"wrapped"`
}

func hasKeys(c store.Channel) bool {
	return c.Kind == store.KindText || c.Kind == store.KindVoice || c.IsPrivate()
}

func (s *Server) historyAllowed(ctx context.Context, c store.Channel) (bool, error) {
	if c.IsPrivate() {
		return true, nil
	}
	srv, err := s.db.GetServer(ctx, c.ServerID)
	if err != nil {
		return false, err
	}
	return srv.HistoryVisible, nil
}

func setOf(ids []id.ID) map[id.ID]bool {
	m := make(map[id.ID]bool, len(ids))
	for _, v := range ids {
		m[v] = true
	}
	return m
}

func minus(a []id.ID, b map[id.ID]bool) []id.ID {
	var out []id.ID
	for _, v := range a {
		if !b[v] {
			out = append(out, v)
		}
	}
	return out
}

// staleHolders lists holders of the current key who may no longer see the
// channel. Any such holder means the key must be replaced before reuse.
func (s *Server) staleHolders(ctx context.Context, c store.Channel, viewers []id.ID) ([]id.ID, error) {
	if c.KeyEpoch == 0 {
		return nil, nil
	}
	holders, err := s.db.EpochHolders(ctx, c.ID, c.KeyEpoch)
	if err != nil {
		return nil, err
	}
	return minus(holders, setOf(viewers)), nil
}

func (s *Server) getChannelKeys(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.ViewChannel)
	if err != nil {
		return err
	}
	if !hasKeys(c) {
		return errNotFound
	}
	ctx := r.Context()
	mine, err := s.db.ChannelKeysFor(ctx, c.ID, auth.User)
	if err != nil {
		return err
	}
	viewers, err := s.channelAudience(ctx, c)
	if err != nil {
		return err
	}
	holders, err := s.db.EpochHolders(ctx, c.ID, c.KeyEpoch)
	if err != nil {
		return err
	}
	holdsCurrent := false
	for _, k := range mine {
		holdsCurrent = holdsCurrent || k.Epoch == c.KeyEpoch
	}
	history, err := s.historyAllowed(ctx, c)
	if err != nil {
		return err
	}
	resp := map[string]any{
		"channel_id":      c.ID,
		"epoch":           c.KeyEpoch,
		"keys":            orEmpty(mine),
		"rotate":          len(minus(holders, setOf(viewers))) > 0,
		"history_visible": history,
	}
	// Only someone able to share or replace the key needs the membership.
	if holdsCurrent || c.KeyEpoch == 0 {
		resp["viewers"] = viewers
		resp["missing"] = orEmpty(minus(viewers, setOf(holders)))
	}
	writeJSON(w, http.StatusOK, resp)
	return nil
}

func (s *Server) postChannelKeys(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.ViewChannel)
	if err != nil {
		return err
	}
	if !hasKeys(c) {
		return errNotFound
	}
	var body struct {
		Epoch  int           `json:"epoch"`
		Rotate bool          `json:"rotate"`
		Keys   []sealedInput `json:"keys"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	viewers, err := s.channelAudience(ctx, c)
	if err != nil {
		return err
	}
	canSee := setOf(viewers)
	keys := make([]store.SealedKey, 0, len(body.Keys))
	seen := map[id.ID]bool{}
	for _, k := range body.Keys {
		if seen[k.UserID] || k.Wrapped == "" || len(k.Wrapped) > maxWrappedLen {
			return fail(http.StatusBadRequest, "bad_keys", "Malformed encrypted keys.")
		}
		if !canSee[k.UserID] {
			return fail(http.StatusConflict, "viewers_changed", "Membership changed. Fetch it again.")
		}
		seen[k.UserID] = true
		keys = append(keys, store.SealedKey{UserID: k.UserID, Wrapped: k.Wrapped})
	}

	if body.Rotate {
		if body.Epoch != c.KeyEpoch+1 {
			return fail(http.StatusConflict, "stale_epoch", "The key changed meanwhile. Fetch it again.")
		}
		// A new generation must reach everyone who can see the channel, or
		// a member could quietly lock others out.
		if len(keys) != len(viewers) {
			return fail(http.StatusConflict, "viewers_changed", "Membership changed. Fetch it again.")
		}
		err := s.db.RotateChannelKey(ctx, c.ID, c.KeyEpoch, auth.User, keys)
		if errors.Is(err, store.ErrStaleEpoch) {
			return fail(http.StatusConflict, "stale_epoch", "The key changed meanwhile. Fetch it again.")
		}
		if err != nil {
			return err
		}
		s.toChannel(ctx, c, "keys.rotated", map[string]any{"channel_id": c.ID, "epoch": body.Epoch})
		w.WriteHeader(http.StatusNoContent)
		return nil
	}

	if body.Epoch < 1 || body.Epoch > c.KeyEpoch {
		return fail(http.StatusBadRequest, "bad_epoch", "No such key generation.")
	}
	held, err := s.db.HeldEpochs(ctx, c.ID, auth.User)
	if err != nil {
		return err
	}
	holds := false
	for _, e := range held {
		holds = holds || e == body.Epoch
	}
	if !holds {
		return errForbidden
	}
	if body.Epoch < c.KeyEpoch {
		allowed, err := s.historyAllowed(ctx, c)
		if err != nil {
			return err
		}
		if !allowed {
			return fail(http.StatusForbidden, "history_hidden", "This server hides earlier messages from new members.")
		}
	}
	added, err := s.db.ShareChannelKeys(ctx, c.ID, body.Epoch, auth.User, keys)
	if err != nil {
		return err
	}
	if len(added) > 0 {
		s.hub.send(added, "keys.available", map[string]any{"scope": "channel", "id": c.ID})
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) requestChannelKeys(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.ViewChannel)
	if err != nil {
		return err
	}
	if !hasKeys(c) {
		return errNotFound
	}
	var body struct {
		History bool `json:"history"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	if !s.writeLimit.allow("keyreq:" + auth.User.String() + ":" + c.ID.String()) {
		return errRate
	}
	ctx := r.Context()
	held, err := s.db.HeldEpochs(ctx, c.ID, auth.User)
	if err != nil {
		return err
	}
	have := map[int]bool{}
	for _, e := range held {
		have[e] = true
	}
	history := false
	if body.History {
		if history, err = s.historyAllowed(ctx, c); err != nil {
			return err
		}
	}
	var need []int
	for e := 1; e <= c.KeyEpoch; e++ {
		if !have[e] && (e == c.KeyEpoch || history) {
			need = append(need, e)
		}
	}
	if len(need) > 0 {
		s.askHolders(ctx, c, KeyRequest{Scope: "channel", ID: c.ID, UserIDs: []id.ID{auth.User}, Epochs: need, History: history})
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// askHolders forwards a request to the online members holding the current key.
func (s *Server) askHolders(ctx context.Context, c store.Channel, req KeyRequest) {
	holders, err := s.db.EpochHolders(ctx, c.ID, c.KeyEpoch)
	if err != nil {
		slog.Warn("listing key holders", "err", err)
		return
	}
	var online []id.ID
	exclude := setOf(req.UserIDs)
	for _, h := range holders {
		if !exclude[h] && len(s.hub.userSessions(h)) > 0 {
			online = append(online, h)
		}
	}
	if len(online) > 0 {
		s.hub.send(online, "keys.request", req)
	}
}

func (s *Server) getServerKeys(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	ctx := r.Context()
	snap, _, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	resp := map[string]any{"server_id": server}
	mine, err := s.db.ServerKeyFor(ctx, server, auth.User)
	switch {
	case err == nil:
		resp["key"] = mine
		holders, err := s.db.ServerKeyHolders(ctx, server)
		if err != nil {
			return err
		}
		resp["missing"] = orEmpty(minus(snap.MemberIDs(), setOf(holders)))
	case errors.Is(err, store.ErrNotFound):
	default:
		return err
	}
	writeJSON(w, http.StatusOK, resp)
	return nil
}

func (s *Server) postServerKeys(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	var body struct {
		Keys []sealedInput `json:"keys"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	snap, _, err := s.requireServer(ctx, server, auth.User)
	if err != nil {
		return err
	}
	_, err = s.db.ServerKeyFor(ctx, server, auth.User)
	holds := err == nil
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	keys := make([]store.SealedKey, 0, len(body.Keys))
	for _, k := range body.Keys {
		if k.Wrapped == "" || len(k.Wrapped) > maxWrappedLen || !snap.IsMember(k.UserID) {
			return fail(http.StatusBadRequest, "bad_keys", "Malformed encrypted keys.")
		}
		// Someone without the key may only store their own copy, as when
		// they arrive through an invitation that carried it.
		if !holds && k.UserID != auth.User {
			return errForbidden
		}
		keys = append(keys, store.SealedKey{UserID: k.UserID, Wrapped: k.Wrapped})
	}
	added, err := s.db.ShareServerKeys(ctx, server, auth.User, keys)
	if err != nil {
		return err
	}
	if len(added) > 0 {
		s.hub.send(added, "keys.available", map[string]any{"scope": "server", "id": server})
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) requestServerKey(w http.ResponseWriter, r *http.Request, auth Auth) error {
	server, err := pathID(r, "server")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if _, _, err := s.requireServer(ctx, server, auth.User); err != nil {
		return err
	}
	if !s.writeLimit.allow("srvkeyreq:" + auth.User.String() + ":" + server.String()) {
		return errRate
	}
	s.askServerHolders(ctx, server, []id.ID{auth.User})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) askServerHolders(ctx context.Context, server id.ID, users []id.ID) {
	holders, err := s.db.ServerKeyHolders(ctx, server)
	if err != nil {
		slog.Warn("listing server key holders", "err", err)
		return
	}
	exclude := setOf(users)
	var online []id.ID
	for _, h := range holders {
		if !exclude[h] && len(s.hub.userSessions(h)) > 0 {
			online = append(online, h)
		}
	}
	if len(online) > 0 {
		s.hub.send(online, "keys.request", KeyRequest{Scope: "server", ID: server, UserIDs: users})
	}
}

// requestMissingKeys asks online holders to serve everyone in a server who
// lacks a key they should have. It runs after anything that can grant access.
func (s *Server) requestMissingKeys(ctx context.Context, server id.ID) {
	snap, err := s.snapshot(ctx, server)
	if err != nil {
		return
	}
	holders, err := s.db.ServerKeyHolders(ctx, server)
	if err != nil {
		return
	}
	if missing := minus(snap.MemberIDs(), setOf(holders)); len(missing) > 0 && len(holders) > 0 {
		s.askServerHolders(ctx, server, missing)
	}
	srv, err := s.db.GetServer(ctx, server)
	if err != nil {
		return
	}
	channels, err := s.db.ServerChannels(ctx, server)
	if err != nil {
		return
	}
	for _, c := range channels {
		if !hasKeys(c) || c.KeyEpoch == 0 {
			continue
		}
		epochHolders, err := s.db.EpochHolders(ctx, c.ID, c.KeyEpoch)
		if err != nil {
			continue
		}
		missing := minus(snap.Viewers(c.ID), setOf(epochHolders))
		if len(missing) > 0 {
			s.askHolders(ctx, c, KeyRequest{Scope: "channel", ID: c.ID, UserIDs: missing, Epochs: []int{c.KeyEpoch}, History: srv.HistoryVisible})
		}
	}
}

// requestKeysForUser re-requests everything a user should hold, after their
// identity was replaced.
func (s *Server) requestKeysForUser(ctx context.Context, user id.ID) {
	servers, err := s.db.UserServers(ctx, user)
	if err != nil {
		return
	}
	for _, srv := range servers {
		s.requestMissingKeys(ctx, srv.ID)
	}
	dms, err := s.db.UserDMs(ctx, user)
	if err != nil {
		return
	}
	for _, c := range dms {
		if c.KeyEpoch > 0 {
			s.askHolders(ctx, c, KeyRequest{Scope: "channel", ID: c.ID, UserIDs: []id.ID{user}, Epochs: []int{c.KeyEpoch}, History: true})
		}
	}
}

// pendingKeyRequests lists what a newly connected holder could serve.
func (s *Server) pendingKeyRequests(ctx context.Context, user id.ID, servers []store.Server, dms []store.Channel) []KeyRequest {
	out := []KeyRequest{}
	for _, srv := range servers {
		snap, err := s.snapshot(ctx, srv.ID)
		if err != nil {
			continue
		}
		if _, err := s.db.ServerKeyFor(ctx, srv.ID, user); err == nil {
			holders, err := s.db.ServerKeyHolders(ctx, srv.ID)
			if err == nil {
				if missing := minus(snap.MemberIDs(), setOf(holders)); len(missing) > 0 {
					out = append(out, KeyRequest{Scope: "server", ID: srv.ID, UserIDs: missing})
				}
			}
		}
		channels, err := s.db.ServerChannels(ctx, srv.ID)
		if err != nil {
			continue
		}
		for _, c := range channels {
			if req, ok := s.pendingFor(ctx, user, c, snap.Viewers(c.ID), srv.HistoryVisible); ok {
				out = append(out, req)
			}
		}
	}
	for _, c := range dms {
		if req, ok := s.pendingFor(ctx, user, c, c.Recipients, true); ok {
			out = append(out, req)
		}
	}
	return out
}

func (s *Server) pendingFor(ctx context.Context, user id.ID, c store.Channel, viewers []id.ID, history bool) (KeyRequest, bool) {
	if !hasKeys(c) || c.KeyEpoch == 0 {
		return KeyRequest{}, false
	}
	holders, err := s.db.EpochHolders(ctx, c.ID, c.KeyEpoch)
	if err != nil {
		return KeyRequest{}, false
	}
	held := setOf(holders)
	if !held[user] {
		return KeyRequest{}, false
	}
	missing := minus(viewers, held)
	if len(missing) == 0 {
		return KeyRequest{}, false
	}
	return KeyRequest{Scope: "channel", ID: c.ID, UserIDs: missing, Epochs: []int{c.KeyEpoch}, History: history}, true
}

// requireFreshKey refuses to accept new ciphertext under a key that someone
// without access still holds, or under an outdated generation.
func (s *Server) requireFreshKey(ctx context.Context, c store.Channel, epoch int) error {
	if c.KeyEpoch == 0 {
		return fail(http.StatusConflict, "no_keys", "This channel has no key yet.")
	}
	if epoch != c.KeyEpoch {
		return fail(http.StatusConflict, "stale_epoch", "The channel key changed. Fetch it again.")
	}
	viewers, err := s.channelAudience(ctx, c)
	if err != nil {
		return err
	}
	stale, err := s.staleHolders(ctx, c, viewers)
	if err != nil {
		return err
	}
	if len(stale) > 0 {
		return fail(http.StatusConflict, "rotate_keys", "Someone lost access: the channel key must be replaced first.")
	}
	return nil
}
