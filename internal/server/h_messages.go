package server

import (
	"context"
	"net/http"
	"time"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/store"
)

const (
	maxAttachments         = 10
	maxReactionsPerUser    = 20
	maxReactionsPerPost    = 500
	maxMentionsPerPost     = 50
	maxRoleMentionsPerPost = 10
)

// mentionInput is what a client declares a message addresses. The server
// cannot read messages, so it learns mentions from the sender, then checks
// them: only people who can see the channel count, @everyone needs the right
// to use it, and roles must be mentionable.
type mentionInput struct {
	Mentions        []id.ID `json:"mentions"`
	MentionRoles    []id.ID `json:"mention_roles"`
	MentionEveryone bool    `json:"mention_everyone"`
}

type mentionResult struct {
	users    []id.ID // recorded as mentions
	notify   []id.ID // whose unread-mention counter goes up
	everyone bool
}

func (s *Server) resolveMentions(ctx context.Context, c store.Channel, author id.ID, perms perm.Perm, in mentionInput) (mentionResult, error) {
	var result mentionResult
	if len(in.Mentions) > maxMentionsPerPost || len(in.MentionRoles) > maxRoleMentionsPerPost {
		return result, fail(http.StatusBadRequest, "too_many_mentions", "That message mentions too many people.")
	}
	audience, err := s.channelAudience(ctx, c)
	if err != nil {
		return result, err
	}
	canSee := setOf(audience)
	notified := map[id.ID]bool{}
	notify := func(u id.ID) {
		if u != author && canSee[u] && !notified[u] {
			notified[u] = true
			result.notify = append(result.notify, u)
		}
	}
	seen := map[id.ID]bool{}
	for _, u := range in.Mentions {
		if seen[u] || !canSee[u] {
			continue
		}
		seen[u] = true
		result.users = append(result.users, u)
		notify(u)
	}
	if c.IsPrivate() {
		// In a private conversation every message is addressed to everyone.
		for _, u := range audience {
			notify(u)
		}
		return result, nil
	}
	snap, err := s.snapshot(ctx, c.ServerID)
	if err != nil {
		return result, err
	}
	if len(in.MentionRoles) > 0 {
		roles, err := s.db.ListRoles(ctx, c.ServerID)
		if err != nil {
			return result, err
		}
		mentionable := map[id.ID]bool{}
		for _, r := range roles {
			mentionable[r.ID] = r.ID != c.ServerID && (r.Mentionable || perms.Has(perm.MentionEveryone))
		}
		for _, role := range in.MentionRoles {
			if !mentionable[role] {
				continue
			}
			for user, held := range snap.Members {
				for _, r := range held {
					if r == role {
						notify(user)
						break
					}
				}
			}
		}
	}
	if in.MentionEveryone && perms.Has(perm.MentionEveryone) {
		result.everyone = true
		for _, u := range audience {
			notify(u)
		}
	}
	return result, nil
}

func isTextual(c store.Channel) bool {
	return c.Kind == store.KindText || c.IsPrivate()
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.ReadHistory)
	if err != nil {
		return err
	}
	if !isTextual(c) {
		return errNotFound
	}
	q := store.MessageQuery{Channel: c.ID, Limit: queryInt(r, "limit", 50, 1, 100)}
	if q.Before, err = queryID(r, "before"); err != nil {
		return err
	}
	if q.After, err = queryID(r, "after"); err != nil {
		return err
	}
	if q.Around, err = queryID(r, "around"); err != nil {
		return err
	}
	list, err := s.db.ListMessages(r.Context(), q)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, orEmpty(list))
	return nil
}

func (s *Server) postMessage(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, perms, err := s.loadChannel(r, auth, perm.SendMessages)
	if err != nil {
		return err
	}
	if !isTextual(c) {
		return errNotFound
	}
	if !s.messageLimit.allow(auth.User.String()) {
		return errRate
	}
	var body struct {
		mentionInput
		Content     string  `json:"content"`
		ReplyTo     id.ID   `json:"reply_to"`
		Attachments []id.ID `json:"attachments"`
		Nonce       string  `json:"nonce"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	env, err := parseEnvelope("content", body.Content, maxContentLen)
	if err != nil {
		return err
	}
	if len(body.Attachments) > maxAttachments {
		return fail(http.StatusBadRequest, "too_many_files", "Up to 10 files per message.")
	}
	if len(body.Attachments) > 0 && !perms.Has(perm.AttachFiles) {
		return errForbidden
	}
	if len(body.Nonce) > 64 {
		return fail(http.StatusBadRequest, "bad_nonce", "Malformed nonce.")
	}
	ctx := r.Context()
	if err := s.requireFreshKey(ctx, c, env.E); err != nil {
		return err
	}
	if c.Kind == store.KindDM {
		participants, err := s.db.DMParticipants(ctx, c.ID)
		if err != nil {
			return err
		}
		for _, p := range participants {
			if p == auth.User {
				continue
			}
			blocked, err := s.isBlocked(ctx, auth.User, p)
			if err != nil {
				return err
			}
			if blocked {
				return fail(http.StatusForbidden, "blocked", "Your message could not be delivered.")
			}
		}
	}
	mentions, err := s.resolveMentions(ctx, c, auth.User, perms, body.mentionInput)
	if err != nil {
		return err
	}
	message, err := s.db.CreateMessage(ctx, store.NewMessage{
		ChannelID:       c.ID,
		AuthorID:        auth.User,
		Content:         body.Content,
		ReplyTo:         body.ReplyTo,
		Mentions:        mentions.users,
		MentionEveryone: mentions.everyone,
		Attachments:     body.Attachments,
		Notify:          mentions.notify,
		TTL:             time.Duration(c.TTLSeconds) * time.Second,
	})
	if err != nil {
		return err
	}
	if c.IsPrivate() {
		// Someone who closed the conversation gets it back when it continues.
		revived, err := s.db.UnhideDM(ctx, c.ID)
		if err != nil {
			return err
		}
		if len(revived) > 0 {
			full, err := s.dmChannel(ctx, c.ID)
			if err != nil {
				return err
			}
			s.hub.send(revived, "dm.create", s.dmEvent(ctx, full))
		}
	}
	out := struct {
		store.Message
		Nonce string `json:"nonce,omitempty"`
	}{message, body.Nonce}
	s.toChannel(ctx, c, "message.create", out)
	if len(mentions.notify) > 0 {
		s.hub.send(mentions.notify, "mention.create", map[string]any{"channel_id": c.ID, "message_id": message.ID})
	}
	writeJSON(w, http.StatusCreated, out)
	return nil
}

// loadMessage fetches the message in the URL and checks it is in the channel.
func (s *Server) loadMessage(r *http.Request, c store.Channel) (store.Message, error) {
	message, err := pathID(r, "message")
	if err != nil {
		return store.Message{}, err
	}
	m, err := s.db.GetMessage(r.Context(), message)
	if err != nil {
		return m, err
	}
	if m.ChannelID != c.ID {
		return m, errNotFound
	}
	return m, nil
}

func (s *Server) editMessage(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, perms, err := s.loadChannel(r, auth, 0)
	if err != nil {
		return err
	}
	m, err := s.loadMessage(r, c)
	if err != nil {
		return err
	}
	if m.AuthorID != auth.User || m.Kind != "default" {
		return errForbidden
	}
	var body struct {
		mentionInput
		Content string `json:"content"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	env, err := parseEnvelope("content", body.Content, maxContentLen)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireFreshKey(ctx, c, env.E); err != nil {
		return err
	}
	mentions, err := s.resolveMentions(ctx, c, auth.User, perms, body.mentionInput)
	if err != nil {
		return err
	}
	if err := s.db.EditMessage(ctx, m.ID, body.Content, mentions.users, mentions.everyone); err != nil {
		return err
	}
	updated, err := s.db.GetMessage(ctx, m.ID)
	if err != nil {
		return err
	}
	s.toChannel(ctx, c, "message.update", updated)
	writeJSON(w, http.StatusOK, updated)
	return nil
}

func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, perms, err := s.loadChannel(r, auth, 0)
	if err != nil {
		return err
	}
	m, err := s.loadMessage(r, c)
	if err != nil {
		return err
	}
	if m.AuthorID != auth.User && !perms.Has(perm.ManageMessages) {
		return errForbidden
	}
	ctx := r.Context()
	files, err := s.db.DeleteMessage(ctx, c.ID, m.ID)
	if err != nil {
		return err
	}
	s.removeFiles(files)
	if m.AuthorID != auth.User && !c.IsPrivate() {
		s.audit(ctx, c.ServerID, auth.User, "message.delete", m.AuthorID, "")
	}
	s.toChannel(ctx, c, "message.delete", map[string]any{"id": m.ID, "channel_id": c.ID})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) addReaction(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.AddReactions|perm.ReadHistory)
	if err != nil {
		return err
	}
	m, err := s.loadMessage(r, c)
	if err != nil {
		return err
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	env, err := parseEnvelope("reaction", body.Content, maxReactionLen)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireFreshKey(ctx, c, env.E); err != nil {
		return err
	}
	total, mine, err := s.db.ReactionCounts(ctx, m.ID, auth.User)
	if err != nil {
		return err
	}
	if total >= maxReactionsPerPost || mine >= maxReactionsPerUser {
		return fail(http.StatusBadRequest, "too_many_reactions", "That message has too many reactions.")
	}
	reaction, err := s.db.AddReaction(ctx, m.ID, auth.User, body.Content)
	if err != nil {
		return err
	}
	s.toChannel(ctx, c, "reaction.add", map[string]any{"channel_id": c.ID, "message_id": m.ID, "reaction": reaction})
	writeJSON(w, http.StatusCreated, reaction)
	return nil
}

func (s *Server) removeReaction(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, perms, err := s.loadChannel(r, auth, perm.ReadHistory)
	if err != nil {
		return err
	}
	m, err := s.loadMessage(r, c)
	if err != nil {
		return err
	}
	reactionID, err := pathID(r, "reaction")
	if err != nil {
		return err
	}
	ctx := r.Context()
	reaction, message, err := s.db.GetReaction(ctx, reactionID)
	if err != nil {
		return err
	}
	if message != m.ID {
		return errNotFound
	}
	if reaction.UserID != auth.User && !perms.Has(perm.ManageMessages) {
		return errForbidden
	}
	if err := s.db.RemoveReaction(ctx, reactionID); err != nil {
		return err
	}
	s.toChannel(ctx, c, "reaction.remove", map[string]any{"channel_id": c.ID, "message_id": m.ID, "id": reactionID})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listPins(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.ReadHistory)
	if err != nil {
		return err
	}
	list, err := s.db.PinnedMessages(r.Context(), c.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, orEmpty(list))
	return nil
}

func (s *Server) setPin(w http.ResponseWriter, r *http.Request, auth Auth, pinned bool) error {
	c, perms, err := s.loadChannel(r, auth, 0)
	if err != nil {
		return err
	}
	if !perms.Has(perm.ManageMessages) && !perms.Has(perm.ManageMessagesPinOnly) {
		return errForbidden
	}
	m, err := s.loadMessage(r, c)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.db.SetPinned(ctx, c.ID, m.ID, pinned); err != nil {
		return err
	}
	updated, err := s.db.GetMessage(ctx, m.ID)
	if err != nil {
		return err
	}
	s.toChannel(ctx, c, "message.update", updated)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) pinMessage(w http.ResponseWriter, r *http.Request, auth Auth) error {
	return s.setPin(w, r, auth, true)
}

func (s *Server) unpinMessage(w http.ResponseWriter, r *http.Request, auth Auth) error {
	return s.setPin(w, r, auth, false)
}

func (s *Server) typing(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, perm.SendMessages)
	if err != nil {
		return err
	}
	s.toChannel(r.Context(), c, "typing.start", map[string]any{"channel_id": c.ID, "user_id": auth.User})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) markRead(w http.ResponseWriter, r *http.Request, auth Auth) error {
	c, _, err := s.loadChannel(r, auth, 0)
	if err != nil {
		return err
	}
	var body struct {
		MessageID id.ID `json:"message_id"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	state, err := s.db.MarkRead(ctx, auth.User, c.ID, body.MessageID)
	if err != nil {
		return err
	}
	s.hub.send([]id.ID{auth.User}, "read.update", state)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
