// Package server is Pravda's application layer: the REST API, the realtime
// gateway, and the policy that decides who may do what.
package server

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/sfu"
	"pravda/internal/store"
)

// Version is the release number shown to clients. Release builds stamp it
// with -ldflags "-X pravda/internal/server.Version=<version>".
var Version = "0.3.0"

// Registration modes.
const (
	RegistrationOpen   = "open"   // anyone may create an account
	RegistrationInvite = "invite" // accounts need a server invite (the first account never does)
	RegistrationClosed = "closed" // no new accounts (the first account excepted)
)

// Config holds instance settings.
type Config struct {
	Name           string // shown on the sign-in page
	DataDir        string
	Registration   string
	Require2FA     bool // every account must set up an authenticator app
	MaxUploadBytes int64
	PublicURL      string // extra allowed Origin, for reverse proxies
	TrustProxy     bool   // honour X-Forwarded-For
	Media          sfu.Config
}

// Server ties the pieces together.
type Server struct {
	cfg      Config
	db       *store.Store
	hub      *Hub
	voice    *Voice
	web      fs.FS
	etags    map[string]string
	secret   *instanceKey
	mfa      mfaTickets
	recovery mfaTickets

	snapMu       sync.Mutex
	snapshots    map[id.ID]*perm.Snapshot
	snapVersions map[id.ID]uint64

	hashSlots chan struct{} // bounds concurrent password hashing

	loginLimit    *limiter
	registerLimit *limiter
	writeLimit    *limiter
	messageLimit  *limiter
	uploadLimit   *limiter
	gateLimit     *limiter

	stop chan struct{}
	wg   sync.WaitGroup
}

// New builds a server. web holds the client files and may be nil for tests.
func New(cfg Config, db *store.Store, web fs.FS) (*Server, error) {
	if cfg.Name == "" {
		cfg.Name = "Pravda"
	}
	if cfg.Registration == "" {
		cfg.Registration = RegistrationInvite
	}
	if cfg.MaxUploadBytes == 0 {
		cfg.MaxUploadBytes = 100 << 20
	}
	if err := os.MkdirAll(filepath.Join(cfg.DataDir, "uploads"), 0o700); err != nil {
		return nil, err
	}
	secret, err := loadInstanceKey(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:          cfg,
		db:           db,
		web:          web,
		secret:       secret,
		snapshots:    map[id.ID]*perm.Snapshot{},
		snapVersions: map[id.ID]uint64{},
		hashSlots:    make(chan struct{}, 4),
		stop:         make(chan struct{}),

		loginLimit:    newLimiter(10.0/60, 10),
		registerLimit: newLimiter(5.0/3600, 5),
		writeLimit:    newLimiter(20, 40),
		messageLimit:  newLimiter(5, 10),
		uploadLimit:   newLimiter(2, 5),
		gateLimit:     newLimiter(5.0/60, 5),
	}
	s.hub = newHub(s)
	voice, err := newVoice(s, cfg.Media)
	if err != nil {
		return nil, err
	}
	s.voice = voice
	s.etags = computeETags(web)
	s.wg.Add(2)
	go s.janitor()
	go s.expiryLoop()
	return s, nil
}

// Close stops background work and drops all connections.
func (s *Server) Close() {
	close(s.stop)
	s.wg.Wait()
	s.voice.close()
	s.hub.closeAll()
}

// janitor removes uploads that were never attached to a message.
func (s *Server) janitor() {
	defer s.wg.Done()
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
		}
		s.mfa.sweep()
		s.recovery.sweep()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		files, err := s.db.ClaimOrphanAttachments(ctx, 2*time.Hour)
		cancel()
		if err != nil {
			slog.Warn("cleaning orphan uploads", "err", err)
			continue
		}
		s.removeFiles(files)
	}
}

// expiryLoop deletes disappearing messages when their time is up and tells
// everyone who could see them.
func (s *Server) expiryLoop() {
	defer s.wg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
		}
		s.sweepExpired()
	}
}

func (s *Server) sweepExpired() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	gone, files, err := s.db.ClaimExpiredMessages(ctx)
	if err != nil {
		slog.Warn("removing expired messages", "err", err)
		return
	}
	s.removeFiles(files)
	channels := map[id.ID]store.Channel{}
	for _, e := range gone {
		c, ok := channels[e.ChannelID]
		if !ok {
			if c, err = s.db.GetChannel(ctx, e.ChannelID); err != nil {
				continue
			}
			channels[e.ChannelID] = c
		}
		s.toChannel(ctx, c, "message.delete", map[string]any{"id": e.ID, "channel_id": e.ChannelID, "expired": true})
	}
}

// Handler returns the HTTP entry point.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	route := func(pattern string, h http.HandlerFunc) { mux.HandleFunc(pattern, h) }

	route("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	route("GET /gateway", s.handleGateway)
	route("GET /media/{id}/{name}", s.handleMedia)

	const v = "/api/v1"
	route("GET "+v+"/instance", s.public(s.getInstance))
	route("POST "+v+"/auth/prelogin", s.public(s.prelogin))
	route("POST "+v+"/auth/register", s.public(s.register))
	route("POST "+v+"/auth/login", s.public(s.login))
	route("POST "+v+"/auth/login/mfa", s.public(s.loginMFA))
	route("POST "+v+"/auth/recover", s.public(s.recover))
	route("POST "+v+"/auth/recover/complete", s.public(s.recoverComplete))
	route("GET "+v+"/invites/{code}", s.public(s.getInvite))

	// Allowed while the account must still set up an authenticator.
	route("POST "+v+"/auth/logout", s.authedAny(s.logout))
	route("POST "+v+"/auth/totp/setup", s.authedAny(s.totpSetup))
	route("POST "+v+"/auth/totp/enable", s.authedAny(s.totpEnable))
	route("GET "+v+"/users/@me", s.authedAny(s.getMe))
	route("GET "+v+"/users/@me/bundle", s.authedAny(s.getBundle))

	route("POST "+v+"/auth/totp/disable", s.authed(s.totpDisable))
	route("POST "+v+"/auth/recovery-codes", s.authed(s.regenerateRecoveryCodes))
	route("PATCH "+v+"/users/@me", s.authed(s.patchMe))
	route("PUT "+v+"/users/@me/password", s.authed(s.changePassword))
	route("PUT "+v+"/users/@me/keys", s.authed(s.resetKeys))
	route("GET "+v+"/users/@me/sessions", s.authed(s.listSessions))
	route("DELETE "+v+"/users/@me/sessions/{session}", s.authed(s.revokeSession))
	route("GET "+v+"/users/{user}", s.authed(s.getUser))

	route("GET "+v+"/relationships", s.authed(s.listRelationships))
	route("POST "+v+"/relationships", s.authed(s.addFriend))
	route("PUT "+v+"/relationships/{user}", s.authed(s.putRelationship))
	route("DELETE "+v+"/relationships/{user}", s.authed(s.deleteRelationship))

	route("POST "+v+"/dms", s.authed(s.createDM))
	route("DELETE "+v+"/dms/{channel}", s.authed(s.hideDM))
	route("POST "+v+"/uploads", s.authed(s.upload))

	route("POST "+v+"/servers", s.authed(s.createServer))
	route("PATCH "+v+"/servers/{server}", s.authed(s.patchServer))
	route("DELETE "+v+"/servers/{server}", s.authed(s.deleteServer))
	route("POST "+v+"/servers/{server}/leave", s.authed(s.leaveServer))
	route("GET "+v+"/servers/{server}/gate", s.authed(s.getGate))
	route("PUT "+v+"/servers/{server}/gate", s.authed(s.putGate))
	route("GET "+v+"/servers/{server}/keys", s.authed(s.getServerKeys))
	route("POST "+v+"/servers/{server}/keys", s.authed(s.postServerKeys))
	route("POST "+v+"/servers/{server}/keys/request", s.authed(s.requestServerKey))
	route("GET "+v+"/servers/{server}/invites", s.authed(s.listInvites))
	route("GET "+v+"/servers/{server}/audit", s.authed(s.listAudit))
	route("GET "+v+"/servers/{server}/bans", s.authed(s.listBans))
	route("PUT "+v+"/servers/{server}/bans/{user}", s.authed(s.banMember))
	route("DELETE "+v+"/servers/{server}/bans/{user}", s.authed(s.unbanMember))
	route("PATCH "+v+"/servers/{server}/members/{user}", s.authed(s.patchMember))
	route("DELETE "+v+"/servers/{server}/members/{user}", s.authed(s.kickMember))
	route("POST "+v+"/servers/{server}/voice/{user}/disconnect", s.authed(s.voiceDisconnect))
	route("POST "+v+"/servers/{server}/roles", s.authed(s.createRole))
	route("PUT "+v+"/servers/{server}/roles/order", s.authed(s.orderRoles))
	route("PATCH "+v+"/servers/{server}/roles/{role}", s.authed(s.patchRole))
	route("DELETE "+v+"/servers/{server}/roles/{role}", s.authed(s.deleteRole))
	route("POST "+v+"/servers/{server}/channels", s.authed(s.createChannel))
	route("PUT "+v+"/servers/{server}/channels/order", s.authed(s.orderChannels))

	route("PATCH "+v+"/channels/{channel}", s.authed(s.patchChannel))
	route("DELETE "+v+"/channels/{channel}", s.authed(s.deleteChannel))
	route("GET "+v+"/channels/{channel}/keys", s.authed(s.getChannelKeys))
	route("POST "+v+"/channels/{channel}/keys", s.authed(s.postChannelKeys))
	route("POST "+v+"/channels/{channel}/keys/request", s.authed(s.requestChannelKeys))
	route("PUT "+v+"/channels/{channel}/overwrites/{kind}/{target}", s.authed(s.putOverwrite))
	route("DELETE "+v+"/channels/{channel}/overwrites/{kind}/{target}", s.authed(s.deleteOverwrite))
	route("POST "+v+"/channels/{channel}/invites", s.authed(s.createInvite))
	route("POST "+v+"/channels/{channel}/typing", s.authed(s.typing))
	route("POST "+v+"/channels/{channel}/read", s.authed(s.markRead))
	route("GET "+v+"/channels/{channel}/messages", s.authed(s.listMessages))
	route("POST "+v+"/channels/{channel}/messages", s.authed(s.postMessage))
	route("PATCH "+v+"/channels/{channel}/messages/{message}", s.authed(s.editMessage))
	route("DELETE "+v+"/channels/{channel}/messages/{message}", s.authed(s.deleteMessage))
	route("POST "+v+"/channels/{channel}/messages/{message}/reactions", s.authed(s.addReaction))
	route("DELETE "+v+"/channels/{channel}/messages/{message}/reactions/{reaction}", s.authed(s.removeReaction))
	route("GET "+v+"/channels/{channel}/pins", s.authed(s.listPins))
	route("PUT "+v+"/channels/{channel}/pins/{message}", s.authed(s.pinMessage))
	route("DELETE "+v+"/channels/{channel}/pins/{message}", s.authed(s.unpinMessage))

	route("POST "+v+"/invites/{code}", s.authed(s.joinInvite))
	route("DELETE "+v+"/invites/{code}", s.authed(s.deleteInvite))

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, errNotFound)
	})
	mux.HandleFunc("/", s.handleStatic)
	return securityHeaders(s.cors(mux))
}

// snapshot returns cached permission data for a server.
func (s *Server) snapshot(ctx context.Context, server id.ID) (*perm.Snapshot, error) {
	s.snapMu.Lock()
	if snap := s.snapshots[server]; snap != nil {
		s.snapMu.Unlock()
		return snap, nil
	}
	version := s.snapVersions[server]
	s.snapMu.Unlock()

	snap, err := s.db.Snapshot(ctx, server)
	if err != nil {
		return nil, err
	}
	s.snapMu.Lock()
	// If something changed while loading, this copy may already be stale:
	// use it for this request but do not cache it.
	if s.snapVersions[server] == version {
		s.snapshots[server] = snap
	}
	s.snapMu.Unlock()
	return snap, nil
}

// invalidate forgets a server's cached permission data. Call it after any
// change to roles, members, overwrites, ownership or channel parents.
func (s *Server) invalidate(server id.ID) {
	s.snapMu.Lock()
	defer s.snapMu.Unlock()
	delete(s.snapshots, server)
	s.snapVersions[server]++
}

// dmPerms is what every participant of a private channel holds.
const dmPerms = perm.ViewChannel | perm.SendMessages | perm.ReadHistory | perm.AttachFiles | perm.AddReactions |
	perm.VoiceConnect | perm.VoiceSpeak | perm.VoiceVideo | perm.VoiceStream | perm.ManageMessagesPinOnly

// channelPerms returns a user's rights in a channel.
func (s *Server) channelPerms(ctx context.Context, user id.ID, c store.Channel) (perm.Perm, error) {
	if c.IsPrivate() {
		ok, err := s.db.IsDMParticipant(ctx, c.ID, user)
		if err != nil || !ok {
			return 0, err
		}
		return dmPerms, nil
	}
	snap, err := s.snapshot(ctx, c.ServerID)
	if err != nil {
		return 0, err
	}
	return snap.Channel(user, c.ID), nil
}
