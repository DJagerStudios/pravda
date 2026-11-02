package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"pravda/internal/id"
	"pravda/internal/store"
)

var (
	usernamePattern  = regexp.MustCompile(`^[a-zA-Z0-9_.-]{2,32}$`)
	mediaPathPattern = regexp.MustCompile(`^/media/(\d+)/[^/]+$`)
)

const cookieLifetime = 365 * 24 * time.Hour

// cleanLine trims a single-line string and strips control characters. It
// returns an error naming the field if the result breaks the length limits.
func cleanLine(field, value string, minRunes, maxRunes int) (string, error) {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	n := utf8.RuneCountInString(value)
	if n < minRunes || n > maxRunes {
		return "", fail(http.StatusBadRequest, "invalid_"+field, strings.ReplaceAll(field, "_", " ")+" must be between "+itoa(minRunes)+" and "+itoa(maxRunes)+" characters.")
	}
	return value, nil
}

func itoa(n int) string {
	return id.ID(n).String()
}

func (s *Server) getInstance(w http.ResponseWriter, r *http.Request) error {
	info, err := s.instanceInfo(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, info)
	return nil
}

// setSessionCookie stores the token where scripts cannot read it, so a
// successful XSS cannot steal the session outright.
func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, maxAge time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   int(maxAge.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	})
}

func (s *Server) getMe(w http.ResponseWriter, r *http.Request, auth Auth) error {
	account, err := s.db.GetAccount(r.Context(), auth.User)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": account, "stage": auth.Stage})
	return nil
}

func (s *Server) getUser(w http.ResponseWriter, r *http.Request, auth Auth) error {
	user, err := pathID(r, "user")
	if err != nil {
		return err
	}
	u, err := s.db.GetUser(r.Context(), user)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, u)
	return nil
}

// checkPublicImage confirms a media path is a public image the caller uploaded.
func (s *Server) checkPublicImage(ctx context.Context, user id.ID, path string) error {
	if path == "" {
		return nil
	}
	bad := fail(http.StatusBadRequest, "bad_image", "That image cannot be used.")
	match := mediaPathPattern.FindStringSubmatch(path)
	if match == nil {
		return bad
	}
	attachment, err := id.Parse(match[1])
	if err != nil {
		return bad
	}
	a, err := s.db.GetAttachment(ctx, attachment)
	if err != nil || a.Kind != "public" || a.UploaderID != user {
		return bad
	}
	return nil
}

func (s *Server) patchMe(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var p store.ProfilePatch
	if err := decode(r, w, &p); err != nil {
		return err
	}
	ctx := r.Context()
	if p.DisplayName != nil {
		v, err := cleanLine("display_name", *p.DisplayName, 1, 32)
		if err != nil {
			return err
		}
		p.DisplayName = &v
	}
	if p.Pronouns != nil {
		v, err := cleanLine("pronouns", *p.Pronouns, 0, 40)
		if err != nil {
			return err
		}
		p.Pronouns = &v
	}
	if p.Bio != nil && utf8.RuneCountInString(*p.Bio) > 400 {
		return fail(http.StatusBadRequest, "invalid_bio", "Biographies are limited to 400 characters.")
	}
	if p.CustomStatus != nil {
		v, err := cleanLine("custom_status", *p.CustomStatus, 0, 80)
		if err != nil {
			return err
		}
		p.CustomStatus = &v
	}
	for _, img := range []*string{p.Avatar, p.Banner} {
		if img != nil {
			if err := s.checkPublicImage(ctx, auth.User, *img); err != nil {
				return err
			}
		}
	}
	for _, c := range []*int{p.BannerColor, p.AccentColor} {
		if c != nil && (*c < 0 || *c > 0xFFFFFF) {
			return fail(http.StatusBadRequest, "bad_color", "Colours must be RGB values.")
		}
	}
	if p.Status != nil {
		switch *p.Status {
		case "online", "idle", "dnd", "invisible":
		default:
			return fail(http.StatusBadRequest, "invalid_status", "Unknown status.")
		}
	}
	if err := s.db.UpdateProfile(ctx, auth.User, p); err != nil {
		return err
	}
	account, err := s.db.GetAccount(ctx, auth.User)
	if err != nil {
		return err
	}
	contacts, err := s.db.ContactIDs(ctx, auth.User)
	if err != nil {
		return err
	}
	s.hub.send(contacts, "user.update", account.User)
	s.hub.send([]id.ID{auth.User}, "account.update", account)
	if p.Status != nil {
		s.hub.setStatus(auth.User, *p.Status)
		s.broadcastPresence(ctx, auth.User, s.hub.presence(auth.User))
	}
	writeJSON(w, http.StatusOK, account)
	return nil
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request, auth Auth) error {
	sessions, err := s.db.ListSessions(r.Context(), auth.User)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": orEmpty(sessions), "current": auth.Session})
	return nil
}

func (s *Server) revokeSession(w http.ResponseWriter, r *http.Request, auth Auth) error {
	session, err := pathID(r, "session")
	if err != nil {
		return err
	}
	if err := s.db.DeleteSession(r.Context(), auth.User, session); err != nil {
		return err
	}
	s.hub.endAuth(session)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listRelationships(w http.ResponseWriter, r *http.Request, auth Auth) error {
	list, err := s.db.Relationships(r.Context(), auth.User)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, orEmpty(list))
	return nil
}

// notifyRelationship tells both people how they now stand.
func (s *Server) notifyRelationship(ctx context.Context, a, b id.ID, kindA, kindB string) {
	send := func(to, other id.ID, kind string) {
		if kind == "" {
			s.hub.send([]id.ID{to}, "relationship.remove", map[string]any{"user_id": other})
			return
		}
		u, err := s.db.GetUser(ctx, other)
		if err != nil {
			return
		}
		s.hub.send([]id.ID{to}, "relationship.update", map[string]any{"user_id": other, "kind": kind, "user": u, "status": s.hub.presence(other)})
	}
	send(a, b, kindA)
	send(b, a, kindB)
}

func (s *Server) addFriend(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var body struct {
		Username string `json:"username"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	other, err := s.db.FindUser(ctx, body.Username)
	if err != nil {
		return fail(http.StatusNotFound, "no_such_user", "Nobody has that username.")
	}
	if other.ID == auth.User {
		return fail(http.StatusBadRequest, "self", "You cannot add yourself as a friend.")
	}
	mine, err := s.db.RelationshipKind(ctx, auth.User, other.ID)
	if err != nil {
		return err
	}
	theirs, err := s.db.RelationshipKind(ctx, other.ID, auth.User)
	if err != nil {
		return err
	}
	if mine == "blocked" || theirs == "blocked" {
		// Answer exactly as for a sent request, so a block cannot be detected.
		writeJSON(w, http.StatusOK, map[string]any{"kind": "outgoing", "user_id": other.ID})
		return nil
	}
	kindMine, kindTheirs := "outgoing", "incoming"
	if mine == "incoming" || mine == "friend" {
		kindMine, kindTheirs = "friend", "friend"
	}
	if err := s.db.SetRelationshipPair(ctx, auth.User, other.ID, kindMine, kindTheirs); err != nil {
		return err
	}
	s.notifyRelationship(ctx, auth.User, other.ID, kindMine, kindTheirs)
	writeJSON(w, http.StatusOK, map[string]any{"kind": kindMine, "user_id": other.ID})
	return nil
}

func (s *Server) putRelationship(w http.ResponseWriter, r *http.Request, auth Auth) error {
	other, err := pathID(r, "user")
	if err != nil {
		return err
	}
	if other == auth.User {
		return fail(http.StatusBadRequest, "self", "That would be you.")
	}
	var body struct {
		Kind string `json:"kind"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.db.GetUser(ctx, other); err != nil {
		return err
	}
	mine, err := s.db.RelationshipKind(ctx, auth.User, other)
	if err != nil {
		return err
	}
	theirs, err := s.db.RelationshipKind(ctx, other, auth.User)
	if err != nil {
		return err
	}
	switch body.Kind {
	case "friend":
		if mine != "incoming" {
			return fail(http.StatusBadRequest, "no_request", "There is no request to accept.")
		}
		if err := s.db.SetRelationshipPair(ctx, auth.User, other, "friend", "friend"); err != nil {
			return err
		}
		s.notifyRelationship(ctx, auth.User, other, "friend", "friend")
	case "blocked":
		kindTheirs := ""
		if theirs == "blocked" {
			kindTheirs = "blocked"
		}
		if err := s.db.SetRelationshipPair(ctx, auth.User, other, "blocked", kindTheirs); err != nil {
			return err
		}
		s.notifyRelationship(ctx, auth.User, other, "blocked", kindTheirs)
	default:
		return fail(http.StatusBadRequest, "bad_kind", "Unknown relationship.")
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteRelationship(w http.ResponseWriter, r *http.Request, auth Auth) error {
	other, err := pathID(r, "user")
	if err != nil {
		return err
	}
	ctx := r.Context()
	mine, err := s.db.RelationshipKind(ctx, auth.User, other)
	if err != nil {
		return err
	}
	if mine == "" {
		return errNotFound
	}
	theirs, err := s.db.RelationshipKind(ctx, other, auth.User)
	if err != nil {
		return err
	}
	// Removing my side of anything but a block undoes both directions.
	kindTheirs := ""
	if theirs == "blocked" {
		kindTheirs = "blocked"
	}
	if err := s.db.SetRelationshipPair(ctx, auth.User, other, "", kindTheirs); err != nil {
		return err
	}
	s.notifyRelationship(ctx, auth.User, other, "", kindTheirs)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// isBlocked reports whether either user has blocked the other.
func (s *Server) isBlocked(ctx context.Context, a, b id.ID) (bool, error) {
	ab, err := s.db.RelationshipKind(ctx, a, b)
	if err != nil {
		return false, err
	}
	ba, err := s.db.RelationshipKind(ctx, b, a)
	if err != nil {
		return false, err
	}
	return ab == "blocked" || ba == "blocked", nil
}

const maxGroupSize = 10

func (s *Server) createDM(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var body struct {
		Recipients []id.ID `json:"recipients"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	seen := map[id.ID]bool{auth.User: true}
	participants := []id.ID{auth.User}
	for _, u := range body.Recipients {
		if !seen[u] {
			seen[u] = true
			participants = append(participants, u)
		}
	}
	if len(participants) < 2 || len(participants) > maxGroupSize {
		return fail(http.StatusBadRequest, "bad_recipients", "A conversation needs 2 to 10 people.")
	}
	contacts, err := s.db.ContactIDs(ctx, auth.User)
	if err != nil {
		return err
	}
	known := setOf(contacts)
	for _, u := range participants[1:] {
		if !known[u] {
			return fail(http.StatusForbidden, "not_contact", "You can only message people you share a server with.")
		}
		blocked, err := s.isBlocked(ctx, auth.User, u)
		if err != nil {
			return err
		}
		if blocked {
			return errForbidden
		}
	}
	var c store.Channel
	if len(participants) == 2 {
		existing, err := s.db.FindDM(ctx, participants[0], participants[1])
		if err == nil {
			if err := s.db.SetDMHidden(ctx, existing, auth.User, false); err != nil {
				return err
			}
			if c, err = s.dmChannel(ctx, existing); err != nil {
				return err
			}
			s.hub.send([]id.ID{auth.User}, "dm.create", s.dmEvent(ctx, c))
			writeJSON(w, http.StatusOK, c)
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
	}
	if c, err = s.db.CreateDM(ctx, auth.User, participants); err != nil {
		return err
	}
	c.Perms = dmPerms
	s.hub.send(participants, "dm.create", s.dmEvent(ctx, c))
	writeJSON(w, http.StatusCreated, c)
	return nil
}

func (s *Server) dmChannel(ctx context.Context, channel id.ID) (store.Channel, error) {
	c, err := s.db.GetChannelFresh(ctx, channel)
	if err != nil {
		return c, err
	}
	c.Recipients, err = s.db.DMParticipants(ctx, channel)
	c.Perms = dmPerms
	return c, err
}

func (s *Server) dmEvent(ctx context.Context, c store.Channel) map[string]any {
	c.Perms = dmPerms
	users, err := s.db.UsersByID(ctx, c.Recipients)
	if err != nil {
		slog.Warn("loading DM users", "err", err)
	}
	return map[string]any{"channel": c, "users": orEmpty(users), "presences": s.hub.presences(c.Recipients)}
}

func (s *Server) hideDM(w http.ResponseWriter, r *http.Request, auth Auth) error {
	channel, err := pathID(r, "channel")
	if err != nil {
		return err
	}
	if err := s.db.SetDMHidden(r.Context(), channel, auth.User, true); err != nil {
		return err
	}
	s.hub.send([]id.ID{auth.User}, "dm.remove", map[string]any{"channel_id": channel})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
