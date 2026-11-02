package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/time/rate"

	"pravda/internal/id"
	"pravda/internal/store"
)

const (
	sessionCookie = "pravda_session"
	maxJSONBody   = 1 << 20
)

// apiError is an error with a meaning for clients.
type apiError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string { return e.Message }

func fail(status int, code, message string) *apiError {
	return &apiError{Status: status, Code: code, Message: message}
}

var (
	errNotFound  = fail(http.StatusNotFound, "not_found", "Not found.")
	errForbidden = fail(http.StatusForbidden, "forbidden", "You lack the authority for that.")
	errAuth      = fail(http.StatusUnauthorized, "unauthorized", "Please sign in.")
	errRate      = fail(http.StatusTooManyRequests, "rate_limited", "Too many requests. Try again shortly.")
	errOrigin    = fail(http.StatusForbidden, "bad_origin", "Request came from another site.")
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v != nil {
		if err := json.NewEncoder(w).Encode(v); err != nil {
			slog.Debug("writing response", "err", err)
		}
	}
}

func writeError(w http.ResponseWriter, err error) {
	var ae *apiError
	switch {
	case errors.As(err, &ae):
	case errors.Is(err, store.ErrNotFound):
		ae = errNotFound
	case errors.Is(err, store.ErrConflict):
		ae = fail(http.StatusConflict, "conflict", "That already exists.")
	case errors.Is(err, store.ErrBanned):
		ae = fail(http.StatusForbidden, "banned", "You are banned from this server.")
	case errors.Is(err, store.ErrGone):
		ae = fail(http.StatusGone, "gone", "That is no longer valid.")
	default:
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			ae = fail(http.StatusRequestEntityTooLarge, "too_large", "That is too large.")
			break
		}
		if !errors.Is(err, context.Canceled) {
			slog.Error("request failed", "err", err)
		}
		ae = fail(http.StatusInternalServerError, "internal", "Something went wrong.")
	}
	writeJSON(w, ae.Status, ae)
}

func decode(r *http.Request, w http.ResponseWriter, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return err
		}
		return fail(http.StatusBadRequest, "bad_json", "That request could not be read.")
	}
	return nil
}

func pathID(r *http.Request, name string) (id.ID, error) {
	v, err := id.Parse(r.PathValue(name))
	if err != nil {
		return 0, errNotFound
	}
	return v, nil
}

func queryID(r *http.Request, name string) (id.ID, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return 0, nil
	}
	v, err := id.Parse(raw)
	if err != nil {
		return 0, fail(http.StatusBadRequest, "bad_id", "Invalid "+name+".")
	}
	return v, nil
}

func queryInt(r *http.Request, name string, def, min, max int) int {
	n, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// Auth identifies the caller of a request.
type Auth struct {
	User    id.ID
	Session id.ID
	Stage   string
}

type (
	authedHandler = func(http.ResponseWriter, *http.Request, Auth) error
	publicHandler = func(http.ResponseWriter, *http.Request) error
)

func (s *Server) public(h publicHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			writeError(w, err)
		}
	}
}

var errEnroll = fail(http.StatusForbidden, "mfa_enrollment_required", "Set up your authenticator app first.")

// authed wraps a handler with authentication, CSRF protection and a per-user
// rate limit on writes. It requires a fully set-up account.
func (s *Server) authed(h authedHandler) http.HandlerFunc {
	return s.withAuth(h, false)
}

// authedAny also admits accounts still setting up their authenticator.
func (s *Server) authedAny(h authedHandler) http.HandlerFunc {
	return s.withAuth(h, true)
}

func (s *Server) withAuth(h authedHandler, allowEnroll bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, viaCookie, err := s.authenticate(r)
		if err != nil {
			writeError(w, err)
			return
		}
		if auth.Stage != stageFull && !allowEnroll {
			writeError(w, errEnroll)
			return
		}
		// Bearer tokens are never attached by browsers automatically, so only
		// cookie authentication can be forged by another site. Cookies are
		// refused from other origins outright, reads included.
		if viaCookie && !s.originAllowed(r) {
			writeError(w, errOrigin)
			return
		}
		if r.Method != http.MethodGet && !s.writeLimit.allow(auth.User.String()) {
			writeError(w, errRate)
			return
		}
		if err := h(w, r, auth); err != nil {
			writeError(w, err)
		}
	}
}

func (s *Server) authenticate(r *http.Request) (auth Auth, viaCookie bool, err error) {
	token := ""
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		token = strings.TrimPrefix(h, "Bearer ")
	} else if c, cerr := r.Cookie(sessionCookie); cerr == nil {
		token = c.Value
		viaCookie = true
	}
	if token == "" {
		return auth, viaCookie, errAuth
	}
	auth, err = s.authenticateToken(r.Context(), token)
	return auth, viaCookie, err
}

func (s *Server) authenticateToken(ctx context.Context, token string) (Auth, error) {
	info, err := s.db.SessionOwner(ctx, hashToken(token))
	if errors.Is(err, store.ErrNotFound) {
		return Auth{}, errAuth
	}
	if err != nil {
		return Auth{}, err
	}
	if time.Since(time.UnixMilli(info.LastSeen)) > time.Hour {
		if err := s.db.TouchSession(ctx, info.Session); err != nil {
			slog.Debug("touching session", "err", err)
		}
	}
	return Auth{User: info.User, Session: info.Session, Stage: info.Stage}, nil
}

// originAllowed checks a cookie-authenticated request came from this site.
// Browsers send Origin on cross-site requests; clients that are not browsers
// do not, and cannot be tricked into carrying someone's cookie.
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || s.sameSite(origin, r.Host)
}

func (s *Server) sameSite(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if strings.EqualFold(u.Host, host) {
		return true
	}
	if s.cfg.PublicURL != "" {
		if pub, err := url.Parse(s.cfg.PublicURL); err == nil && strings.EqualFold(pub.Host, u.Host) {
			return true
		}
	}
	return false
}

// cors lets the desktop app, which runs from its own origin, use the API with
// bearer tokens. Credentials (cookies) are never allowed cross-origin, so this
// opens nothing to other websites: their requests carry no session.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		crossOrigin := origin != "" && !s.sameSite(origin, r.Host) &&
			(strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/media/"))
		if crossOrigin {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Argon2id parameters, per the OWASP recommendation for a 64 MiB budget.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 2
	argonKeyLen  = 32
)

// hashPassword derives a PHC-format hash. It waits for a free slot so a burst
// of logins cannot exhaust the server's memory.
func (s *Server) hashPassword(ctx context.Context, password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	select {
	case s.hashSlots <- struct{}{}:
		defer func() { <-s.hashSlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func (s *Server) verifyPassword(ctx context.Context, password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("malformed password hash")
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false, fmt.Errorf("malformed password hash: %w", err)
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	select {
	case s.hashSlots <- struct{}{}:
		defer func() { <-s.hashSlots }()
	case <-ctx.Done():
		return false, ctx.Err()
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// limiter is a set of token buckets keyed by caller.
type limiter struct {
	limit rate.Limit
	burst int

	mu      sync.Mutex
	buckets map[string]*bucket
	swept   time.Time
}

type bucket struct {
	lim  *rate.Limiter
	seen time.Time
}

func newLimiter(perSecond float64, burst int) *limiter {
	return &limiter{limit: rate.Limit(perSecond), burst: burst, buckets: map[string]*bucket{}, swept: time.Now()}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.swept) > 10*time.Minute {
		for k, b := range l.buckets {
			// A bucket idle this long has refilled; forgetting it changes nothing.
			if now.Sub(b.seen) > time.Duration(float64(l.burst)/float64(l.limit))*time.Second+time.Minute {
				delete(l.buckets, k)
			}
		}
		l.swept = now
	}
	b := l.buckets[key]
	if b == nil {
		b = &bucket{lim: rate.NewLimiter(l.limit, l.burst)}
		l.buckets[key] = b
	}
	b.seen = now
	return b.lim.Allow()
}

// clientIP returns the caller's address for rate limiting.
func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			return strings.TrimSpace(parts[len(parts)-1]) // added by our own proxy
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// securityHeaders applies the headers every response should carry.
func securityHeaders(next http.Handler) http.Handler {
	// YouTube's privacy-enhanced player is the only third party allowed, and
	// only inside an iframe the user opted into. https: media covers linked
	// videos in a watch party, again only after the viewer agrees.
	const csp = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: https:; connect-src 'self'; " +
		"frame-src https://www.youtube-nocookie.com; worker-src 'self' blob:; style-src 'self'; font-src 'self'; " +
		"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), speaker-selection=(self)")
		next.ServeHTTP(w, r)
	})
}

func computeETags(web fs.FS) map[string]string {
	tags := map[string]string{}
	if web == nil {
		return tags
	}
	_ = fs.WalkDir(web, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		f, err := web.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		sum := sha256.New()
		if _, err := io.Copy(sum, f); err != nil {
			return err
		}
		tags[p] = `"` + hex.EncodeToString(sum.Sum(nil))[:24] + `"`
		return nil
	})
	return tags
}

// handleStatic serves the client. Unknown paths fall through to index.html so
// links such as /invite/abc and /channels/123 work after a reload.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if s.web == nil {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	tag, ok := s.etags[name]
	if !ok {
		name, tag = "index.html", s.etags["index.html"]
	}
	// Revalidate every time: a new release must reach clients immediately,
	// and an unchanged file costs only a 304.
	w.Header().Set("Cache-Control", "no-cache")
	if tag != "" {
		w.Header().Set("ETag", tag)
		if r.Header.Get("If-None-Match") == tag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	http.ServeFileFS(w, r, s.web, name)
}
