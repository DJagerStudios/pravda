package server

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/sfu"
	"pravda/internal/store"
)

// The tests drive the server the way a real client does, but the server only
// ever sees ciphertext, so envelopes here are well-formed placeholders: what
// matters is what the server accepts, refuses and relays.

type harness struct {
	t   *testing.T
	srv *Server
	ts  *httptest.Server
	mu  sync.Mutex
	n   int
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func newHarness(t *testing.T, registration string) *harness {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{
		DataDir:      dir,
		Registration: registration,
		Require2FA:   true,
		Media:        sfu.Config{UDPPort: freeUDPPort(t), Loopback: true},
	}, db, nil)
	if err != nil {
		t.Fatal(err)
	}
	// One test process is a single IP: the production limits would trip.
	for _, l := range []**limiter{&srv.registerLimit, &srv.loginLimit, &srv.writeLimit, &srv.messageLimit, &srv.uploadLimit, &srv.gateLimit} {
		*l = newLimiter(1000, 1000)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.CloseClientConnections()
		ts.Close()
		srv.Close()
		db.Close()
	})
	return &harness{t: t, srv: srv, ts: ts}
}

// member is a signed-in test user.
type member struct {
	h       *harness
	ID      id.ID
	Token   string
	Name    string
	AuthKey string
	TOTP    []byte
}

func (h *harness) call(token, method, path string, body any, out any) (int, string) {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, h.ts.URL+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil && resp.StatusCode < 300 {
		if err := json.Unmarshal(raw, out); err != nil {
			h.t.Fatalf("%s %s: bad JSON %q: %v", method, path, raw, err)
		}
	}
	return resp.StatusCode, string(raw)
}

func publicKeyB64(t *testing.T, pub any) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(der)
}

func newIdentity(t *testing.T) (signKey, dhKey string) {
	t.Helper()
	sign, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dh, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return publicKeyB64(t, &sign.PublicKey), publicKeyB64(t, dh.PublicKey())
}

func randomB64(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// startRegistration creates an account that has not yet set up an
// authenticator.
// recoveryAuthFor stands in for the client's recovery-key derivation.
func recoveryAuthFor(name string) string {
	sum := [32]byte{}
	copy(sum[:], "recovery-"+name)
	return base64.StdEncoding.EncodeToString(sum[:])
}

func (h *harness) startRegistration(invite string) (*member, int, string) {
	h.t.Helper()
	h.mu.Lock()
	h.n++
	name := fmt.Sprintf("comrade%d", h.n)
	h.mu.Unlock()
	signKey, dhKey := newIdentity(h.t)
	m := &member{h: h, Name: name, AuthKey: randomB64(h.t, 32)}
	var out struct {
		User  store.Account `json:"user"`
		Token string        `json:"token"`
		Stage string        `json:"stage"`
	}
	status, raw := h.call("", "POST", "/api/v1/auth/register", map[string]any{
		"username": name, "auth_key": m.AuthKey, "kdf_salt": randomB64(h.t, 16), "kdf_iterations": 100000,
		"sign_key": signKey, "dh_key": dhKey, "bundle": `{"v":1,"iv":"x","ct":"sealed"}`, "invite": invite,
		"recovery_bundle": `{"v":1,"iv":"x","ct":"recovery"}`, "recovery_auth": recoveryAuthFor(name),
	}, &out)
	m.ID, m.Token = out.User.ID, out.Token
	return m, status, raw
}

// register creates a fully set-up account, authenticator included.
func (h *harness) register(invite string) *member {
	h.t.Helper()
	m, status, raw := h.startRegistration(invite)
	if status != http.StatusCreated {
		h.t.Fatalf("register: %d %s", status, raw)
	}
	m.enrollTOTP()
	return m
}

func (m *member) enrollTOTP() []string {
	m.h.t.Helper()
	var setup struct {
		Secret string `json:"secret"`
		URI    string `json:"uri"`
		QR     string `json:"qr"`
	}
	m.must(http.StatusOK, "POST", "/auth/totp/setup", map[string]any{}, &setup)
	secret, err := base32NoPad.DecodeString(setup.Secret)
	if err != nil {
		m.h.t.Fatal(err)
	}
	if !strings.HasPrefix(setup.URI, "otpauth://totp/") || !strings.HasPrefix(setup.QR, "data:image/png;base64,") {
		m.h.t.Fatalf("authenticator setup is incomplete: %+v", setup)
	}
	m.TOTP = secret
	var enabled struct {
		RecoveryCodes []string `json:"recovery_codes"`
	}
	m.must(http.StatusOK, "POST", "/auth/totp/enable", map[string]string{"code": m.code(0)}, &enabled)
	if len(enabled.RecoveryCodes) != recoveryCodeCount {
		m.h.t.Fatalf("expected %d recovery codes, got %d", recoveryCodeCount, len(enabled.RecoveryCodes))
	}
	return enabled.RecoveryCodes
}

// code computes the authenticator code offset steps from now.
func (m *member) code(offset int64) string {
	return hotp(m.TOTP, time.Now().Unix()/totpPeriod+offset, totpDigits)
}

func (m *member) do(method, path string, body any, out any) (int, string) {
	m.h.t.Helper()
	return m.h.call(m.Token, method, "/api/v1"+path, body, out)
}

func (m *member) must(wantStatus int, method, path string, body any, out any) {
	m.h.t.Helper()
	if status, raw := m.do(method, path, body, out); status != wantStatus {
		m.h.t.Fatalf("%s %s: want %d, got %d: %s", method, path, wantStatus, status, raw)
	}
}

// meta builds a placeholder ciphertext that keeps the plaintext readable to
// the test (the server treats it as opaque).
func meta(label string) string {
	return fmt.Sprintf(`{"v":1,"iv":"aXY=","ct":%q}`, base64.StdEncoding.EncodeToString([]byte(label)))
}

func metaLabel(raw string) string {
	var e envelope
	if json.Unmarshal([]byte(raw), &e) != nil {
		return ""
	}
	label, err := base64.StdEncoding.DecodeString(e.CT)
	if err != nil {
		return ""
	}
	return string(label)
}

func content(epoch int, text string) string {
	return fmt.Sprintf(`{"v":1,"e":%d,"iv":"aXY=","ct":%q,"sig":"c2ln"}`, epoch, base64.StdEncoding.EncodeToString([]byte(text)))
}

// newServer founds a soviet from the standard template, stores the owner's
// server key and gives every channel its first key generation.
func (m *member) newServer(name string) ServerState {
	m.h.t.Helper()
	var st ServerState
	m.must(http.StatusCreated, "POST", "/servers", map[string]any{
		"meta": meta(name),
		"roles": []map[string]any{
			{"meta": meta("comrades"), "permissions": perm.Default},
			{"meta": meta("Commissar"), "permissions": perm.ManageMessages | perm.KickMembers, "hoist": true, "mentionable": true},
			{"meta": meta("Politburo"), "permissions": perm.Administrator, "hoist": true},
		},
		"channels": []map[string]any{
			{"kind": "category", "meta": meta("Bulletins"), "parent": -1},
			{"kind": "text", "meta": meta("general"), "parent": 0, "system": true},
			{"kind": "category", "meta": meta("Assembly Halls"), "parent": -1},
			{"kind": "voice", "meta": meta("Main Hall"), "parent": 2},
		},
	}, &st)
	m.must(http.StatusNoContent, "POST", "/servers/"+st.ID.String()+"/keys", map[string]any{
		"keys": []map[string]any{{"user_id": m.ID, "wrapped": "sealed-for-" + m.Name}},
	}, nil)
	for _, c := range st.Channels {
		if c.Kind != store.KindCategory {
			m.ensureKey(c.ID)
		}
	}
	return st
}

func (st ServerState) channel(t *testing.T, name string) store.Channel {
	t.Helper()
	for _, c := range st.Channels {
		if metaLabel(c.Meta) == name {
			return c
		}
	}
	t.Fatalf("no channel %q", name)
	return store.Channel{}
}

func (st ServerState) role(t *testing.T, name string) store.Role {
	t.Helper()
	for _, r := range st.Roles {
		if metaLabel(r.Meta) == name {
			return r
		}
	}
	t.Fatalf("no role %q", name)
	return store.Role{}
}

type keyState struct {
	Epoch   int               `json:"epoch"`
	Keys    []store.SealedKey `json:"keys"`
	Rotate  bool              `json:"rotate"`
	Viewers []id.ID           `json:"viewers"`
	Missing []id.ID           `json:"missing"`
}

func (m *member) keys(channel id.ID) keyState {
	m.h.t.Helper()
	var ks keyState
	m.must(http.StatusOK, "GET", "/channels/"+channel.String()+"/keys", nil, &ks)
	return ks
}

// rotate starts a new key generation for everyone who can see the channel.
func (m *member) rotate(channel id.ID) int {
	m.h.t.Helper()
	ks := m.keys(channel)
	if ks.Viewers == nil {
		m.h.t.Fatalf("%s cannot rotate: no membership returned", m.Name)
	}
	var sealed []map[string]any
	for _, v := range ks.Viewers {
		sealed = append(sealed, map[string]any{"user_id": v, "wrapped": fmt.Sprintf("epoch%d-for-%s", ks.Epoch+1, v)})
	}
	m.must(http.StatusNoContent, "POST", "/channels/"+channel.String()+"/keys", map[string]any{"epoch": ks.Epoch + 1, "rotate": true, "keys": sealed}, nil)
	return ks.Epoch + 1
}

func (m *member) ensureKey(channel id.ID) int {
	m.h.t.Helper()
	if ks := m.keys(channel); ks.Epoch > 0 {
		return ks.Epoch
	}
	return m.rotate(channel)
}

func (m *member) post(channel id.ID, text string, extra map[string]any) store.Message {
	m.h.t.Helper()
	body := map[string]any{"content": content(m.keys(channel).Epoch, text)}
	for k, v := range extra {
		body[k] = v
	}
	var msg store.Message
	m.must(http.StatusCreated, "POST", "/channels/"+channel.String()+"/messages", body, &msg)
	return msg
}

func (m *member) invite(st ServerState) string {
	m.h.t.Helper()
	var invite store.Invite
	m.must(http.StatusCreated, "POST", "/channels/"+st.channel(m.h.t, "general").ID.String()+"/invites", map[string]any{}, &invite)
	return invite.Code
}

func (m *member) join(code string) {
	m.h.t.Helper()
	m.must(http.StatusOK, "POST", "/invites/"+code, map[string]any{}, nil)
}

// gw is a gateway client.
type gw struct {
	t      *testing.T
	ws     *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	seq    int64
	ready  Ready
	events chan gwEvent
	closed chan websocket.StatusCode
}

type gwEvent struct {
	Op string          `json:"op"`
	S  int64           `json:"s"`
	T  string          `json:"t"`
	D  json.RawMessage `json:"d"`
}

func (h *harness) dial(header http.Header) (*websocket.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(h.ts.URL, "http") + "/gateway"
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(1 << 22)
	h.t.Cleanup(func() { ws.CloseNow() })
	return ws, nil
}

func (h *harness) newGW(header http.Header) *gw {
	h.t.Helper()
	ws, err := h.dial(header)
	if err != nil {
		h.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.t.Cleanup(cancel)
	return &gw{t: h.t, ws: ws, ctx: ctx, cancel: cancel, events: make(chan gwEvent, 512), closed: make(chan websocket.StatusCode, 1)}
}

func (g *gw) send(op string, d any) {
	g.t.Helper()
	b, err := json.Marshal(map[string]any{"op": op, "d": d})
	if err != nil {
		g.t.Fatal(err)
	}
	if err := g.ws.Write(g.ctx, websocket.MessageText, b); err != nil {
		g.t.Fatal(err)
	}
}

func (g *gw) readRaw() (gwEvent, error) {
	_, raw, err := g.ws.Read(g.ctx)
	if err != nil {
		return gwEvent{}, err
	}
	var e gwEvent
	if err := json.Unmarshal(raw, &e); err != nil {
		g.t.Fatal(err)
	}
	return e, nil
}

func (g *gw) pump() {
	for {
		e, err := g.readRaw()
		if err != nil {
			g.closed <- websocket.CloseStatus(err)
			return
		}
		if e.Op == "event" {
			g.seq = e.S
		}
		g.events <- e
	}
}

func (m *member) connect() *gw {
	h := m.h
	h.t.Helper()
	g := h.newGW(nil)
	hello, err := g.readRaw()
	if err != nil || hello.Op != "hello" {
		h.t.Fatalf("expected hello, got %+v %v", hello, err)
	}
	g.send("identify", map[string]string{"token": m.Token})
	ready, err := g.readRaw()
	if err != nil || ready.Op != "ready" {
		h.t.Fatalf("expected ready, got %+v %v", ready, err)
	}
	if err := json.Unmarshal(ready.D, &g.ready); err != nil {
		h.t.Fatal(err)
	}
	go g.pump()
	return g
}

// expect waits for an event named t, skipping others.
func (g *gw) expect(t string) json.RawMessage {
	g.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case e := <-g.events:
			if e.T == t || e.Op == t {
				return e.D
			}
		case <-timeout:
			g.t.Fatalf("timed out waiting for %s", t)
		}
	}
}

// never asserts no event named t arrives within a short window.
func (g *gw) never(t string) {
	g.t.Helper()
	timeout := time.After(300 * time.Millisecond)
	for {
		select {
		case e := <-g.events:
			if e.T == t {
				g.t.Fatalf("unexpected %s: %s", t, e.D)
			}
		case <-timeout:
			return
		}
	}
}

// ---- accounts and authentication ----

func TestRegistrationRequiresAuthenticatorBeforeAnythingElse(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m, status, raw := h.startRegistration("")
	if status != http.StatusCreated || !strings.Contains(raw, `"stage":"enroll"`) {
		t.Fatalf("register: %d %s", status, raw)
	}
	if status, raw := m.do("POST", "/servers", map[string]any{"meta": meta("x"), "roles": []any{map[string]any{"meta": meta("c")}}}, nil); status != http.StatusForbidden ||
		!strings.Contains(raw, "mfa_enrollment_required") {
		t.Fatalf("unenrolled account used the API: %d %s", status, raw)
	}
	g := h.newGW(nil)
	if _, err := g.readRaw(); err != nil {
		t.Fatal(err)
	}
	g.send("identify", map[string]string{"token": m.Token})
	if _, err := g.readRaw(); websocket.CloseStatus(err) != closeAuthFailed {
		t.Fatalf("unenrolled account reached the gateway: %v", err)
	}
	var setup struct {
		Secret string `json:"secret"`
	}
	m.must(http.StatusOK, "POST", "/auth/totp/setup", map[string]any{}, &setup)
	secret, _ := base32NoPad.DecodeString(setup.Secret)
	m.TOTP = secret
	if status, _ := m.do("POST", "/auth/totp/enable", map[string]string{"code": "000000"}, nil); status != http.StatusUnauthorized {
		t.Fatalf("a wrong code enabled the authenticator: %d", status)
	}
	m.must(http.StatusOK, "POST", "/auth/totp/enable", map[string]string{"code": m.code(0)}, nil)
	m.must(http.StatusOK, "GET", "/users/@me/sessions", nil, nil)
}

func TestLoginNeedsPasswordThenCode(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m, _, _ := h.startRegistration("")
	codes := m.enrollTOTP()
	login := func() string {
		var out struct {
			MFA    bool   `json:"mfa_required"`
			Ticket string `json:"ticket"`
			Token  string `json:"token"`
		}
		if status, raw := h.call("", "POST", "/api/v1/auth/login", map[string]string{"username": m.Name, "auth_key": m.AuthKey}, &out); status != http.StatusOK {
			t.Fatalf("login: %d %s", status, raw)
		}
		if !out.MFA || out.Ticket == "" || out.Token != "" {
			t.Fatalf("the password alone must not sign in: %+v", out)
		}
		return out.Ticket
	}
	ticket := login()
	if status, _ := h.call("", "POST", "/api/v1/auth/login/mfa", map[string]string{"ticket": ticket, "code": "123456"}, nil); status != http.StatusUnauthorized {
		t.Fatalf("wrong code accepted: %d", status)
	}
	// The setup consumed the current step: wait for the next one so the code
	// is fresh, then make sure it cannot be used twice.
	time.Sleep(time.Until(time.Unix((time.Now().Unix()/totpPeriod+1)*totpPeriod, 0)) + 50*time.Millisecond)
	code := m.code(0)
	var signedIn struct {
		Token  string          `json:"token"`
		Bundle store.KeyBundle `json:"bundle"`
	}
	if status, raw := h.call("", "POST", "/api/v1/auth/login/mfa", map[string]string{"ticket": ticket, "code": code}, &signedIn); status != http.StatusOK {
		t.Fatalf("correct code refused: %d %s", status, raw)
	}
	if signedIn.Token == "" || signedIn.Bundle.Bundle == "" || signedIn.Bundle.KDFIterations != 100000 {
		t.Fatalf("sign-in must return the sealed key bundle: %+v", signedIn)
	}
	if status, _ := h.call("", "POST", "/api/v1/auth/login/mfa", map[string]string{"ticket": login(), "code": code}, nil); status != http.StatusUnauthorized {
		t.Fatalf("a code was accepted twice: %d", status)
	}
	if status, _ := h.call("", "POST", "/api/v1/auth/login/mfa", map[string]string{"ticket": login(), "recovery_code": codes[0]}, nil); status != http.StatusOK {
		t.Fatalf("recovery code refused: %d", status)
	}
	if status, _ := h.call("", "POST", "/api/v1/auth/login/mfa", map[string]string{"ticket": login(), "recovery_code": codes[0]}, nil); status != http.StatusUnauthorized {
		t.Fatalf("a recovery code worked twice: %d", status)
	}
}

func TestRecoveryKeyResetsAForgottenPassword(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	g := m.connect()
	if status, _ := h.call("", "POST", "/api/v1/auth/recover", map[string]any{"username": m.Name, "recovery_auth": randomB64(t, 32), "code": m.code(0)}, nil); status != http.StatusUnauthorized {
		t.Fatalf("a wrong recovery key worked: %d", status)
	}
	if status, _ := h.call("", "POST", "/api/v1/auth/recover", map[string]any{"username": m.Name, "recovery_auth": recoveryAuthFor(m.Name)}, nil); status != http.StatusUnauthorized {
		t.Fatalf("recovery without the second factor worked: %d", status)
	}
	time.Sleep(time.Until(time.Unix((time.Now().Unix()/totpPeriod+1)*totpPeriod, 0)) + 50*time.Millisecond)
	var started struct {
		Ticket         string `json:"ticket"`
		RecoveryBundle string `json:"recovery_bundle"`
	}
	if status, raw := h.call("", "POST", "/api/v1/auth/recover", map[string]any{"username": m.Name, "recovery_auth": recoveryAuthFor(m.Name), "code": m.code(0)}, &started); status != http.StatusOK {
		t.Fatalf("recover: %d %s", status, raw)
	}
	if !strings.Contains(started.RecoveryBundle, "recovery") {
		t.Fatalf("the recovery-sealed bundle must come back: %q", started.RecoveryBundle)
	}
	newKey := randomB64(t, 32)
	var done struct {
		Token string `json:"token"`
		Stage string `json:"stage"`
	}
	if status, raw := h.call("", "POST", "/api/v1/auth/recover/complete", map[string]any{
		"ticket": started.Ticket, "new_auth_key": newKey, "kdf_salt": randomB64(t, 16), "kdf_iterations": 100000, "bundle": `{"v":1}`,
	}, &done); status != http.StatusOK || done.Stage != stageFull {
		t.Fatalf("complete: %d %s", status, raw)
	}
	select {
	case <-g.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("old sessions survived a password reset")
	}
	if status, _ := m.do("GET", "/users/@me", nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("old token still works: %d", status)
	}
	var login struct {
		MFA bool `json:"mfa_required"`
	}
	if status, _ := h.call("", "POST", "/api/v1/auth/login", map[string]string{"username": m.Name, "auth_key": newKey}, &login); status != http.StatusOK || !login.MFA {
		t.Fatalf("the new password does not work: %d", status)
	}
}

func TestMFATicketsExpireAfterTooManyGuesses(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	var out struct {
		Ticket string `json:"ticket"`
	}
	h.call("", "POST", "/api/v1/auth/login", map[string]string{"username": m.Name, "auth_key": m.AuthKey}, &out)
	for range mfaTicketAttempts {
		h.call("", "POST", "/api/v1/auth/login/mfa", map[string]string{"ticket": out.Ticket, "code": "000000"}, nil)
	}
	if status, raw := h.call("", "POST", "/api/v1/auth/login/mfa", map[string]string{"ticket": out.Ticket, "code": m.code(0)}, nil); status != http.StatusUnauthorized ||
		!strings.Contains(raw, "ticket_expired") {
		t.Fatalf("brute force was not cut off: %d %s", status, raw)
	}
}

func TestSignInDoesNotRevealWhoHasAnAccount(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	pre := func(name string) map[string]any {
		var out map[string]any
		if status, _ := h.call("", "POST", "/api/v1/auth/prelogin", map[string]string{"username": name}, &out); status != http.StatusOK {
			t.Fatalf("prelogin %s: %d", name, status)
		}
		return out
	}
	real, fake := pre(m.Name), pre("nobody-at-all")
	if len(real) != len(fake) || fake["kdf_salt"] == "" || fake["kdf_iterations"] == nil {
		t.Fatalf("prelogin shape differs: %v vs %v", real, fake)
	}
	if again := pre("nobody-at-all"); again["kdf_salt"] != fake["kdf_salt"] {
		t.Fatal("made-up salts must be stable, or repeated lookups reveal them")
	}
	s1, b1 := h.call("", "POST", "/api/v1/auth/login", map[string]string{"username": m.Name, "auth_key": randomB64(t, 32)}, nil)
	s2, b2 := h.call("", "POST", "/api/v1/auth/login", map[string]string{"username": "nobody", "auth_key": randomB64(t, 32)}, nil)
	if s1 != http.StatusUnauthorized || s1 != s2 || b1 != b2 {
		t.Fatalf("responses reveal which accounts exist: %d %q / %d %q", s1, b1, s2, b2)
	}
}

func TestFirstUserRegistersFreelyThenInvitesAreRequired(t *testing.T) {
	h := newHarness(t, RegistrationInvite)
	owner := h.register("")
	if _, status, _ := h.startRegistration(""); status != http.StatusForbidden {
		t.Fatalf("registration without invite: got %d", status)
	}
	st := owner.newServer("Soviet")
	guest := h.register(owner.invite(st))
	guest.join(owner.invite(st))
	if len(guest.connect().ready.Servers) != 1 {
		t.Fatal("invited user should land in the server")
	}
}

func TestReadyNeverSendsNullLists(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	g := h.newGW(nil)
	if _, err := g.readRaw(); err != nil {
		t.Fatal(err)
	}
	g.send("identify", map[string]string{"token": m.Token})
	ready, err := g.readRaw()
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(ready.D, &raw); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"servers", "dms", "relationships", "read_states", "users", "dm_voice", "pending_keys"} {
		if raw[field] == nil || string(raw[field]) == "null" {
			t.Fatalf("a brand-new user's %s is %s; clients need []", field, raw[field])
		}
	}
}

func TestPasswordChangeRevokesOtherLogins(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	other := &member{h: h, ID: m.ID, Token: m.Token}
	var signedIn struct {
		Ticket string `json:"ticket"`
	}
	h.call("", "POST", "/api/v1/auth/login", map[string]string{"username": m.Name, "auth_key": m.AuthKey}, &signedIn)
	var full struct {
		Token string `json:"token"`
	}
	time.Sleep(time.Until(time.Unix((time.Now().Unix()/totpPeriod+1)*totpPeriod, 0)) + 50*time.Millisecond)
	if status, raw := h.call("", "POST", "/api/v1/auth/login/mfa", map[string]string{"ticket": signedIn.Ticket, "code": m.code(0)}, &full); status != http.StatusOK {
		t.Fatalf("mfa: %d %s", status, raw)
	}
	other.Token = full.Token
	g := other.connect()
	newKey := randomB64(t, 32)
	change := map[string]any{"auth_key": randomB64(t, 32), "new_auth_key": newKey, "kdf_salt": randomB64(t, 16), "kdf_iterations": 200000, "bundle": `{"v":1}`}
	if status, _ := m.do("PUT", "/users/@me/password", change, nil); status != http.StatusForbidden {
		t.Fatalf("wrong current password accepted: %d", status)
	}
	change["auth_key"] = m.AuthKey
	m.must(http.StatusNoContent, "PUT", "/users/@me/password", change, nil)
	select {
	case <-g.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("other device stayed connected")
	}
	if status, _ := other.do("GET", "/users/@me", nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("old login still works: %d", status)
	}
	var pre map[string]any
	h.call("", "POST", "/api/v1/auth/prelogin", map[string]string{"username": m.Name}, &pre)
	if pre["kdf_iterations"].(float64) != 200000 {
		t.Fatal("the new key derivation settings were not stored")
	}
}

func TestLogoutEndsLiveSessions(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	g := m.connect()
	m.must(http.StatusNoContent, "POST", "/auth/logout", map[string]any{}, nil)
	select {
	case code := <-g.closed:
		if code != closeAuthFailed {
			t.Fatalf("close code %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("gateway stayed open after logout")
	}
}

// ---- cross-origin rules ----

func TestDesktopAppMayUseTokensCrossOrigin(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	req, _ := http.NewRequest("OPTIONS", h.ts.URL+"/api/v1/users/@me", nil)
	req.Header.Set("Origin", "app://pravda")
	req.Header.Set("Access-Control-Request-Method", "GET")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != "app://pravda" {
		t.Fatalf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
	if resp.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("cookies must never be allowed cross-origin")
	}
	g := h.newGW(http.Header{"Origin": {"app://pravda"}})
	if _, err := g.readRaw(); err != nil {
		t.Fatal(err)
	}
	g.send("identify", map[string]string{"token": m.Token})
	if e, err := g.readRaw(); err != nil || e.Op != "ready" {
		t.Fatalf("token identify from another origin: %+v %v", e, err)
	}
}

func TestCookiesAreRefusedFromOtherOrigins(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/v1/users/@me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: m.Token})
	req.Header.Set("Origin", "https://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cookie read from another site: %d", resp.StatusCode)
	}
	g := h.newGW(http.Header{"Origin": {"https://evil.example"}, "Cookie": {sessionCookie + "=" + m.Token}})
	if _, err := g.readRaw(); err != nil {
		t.Fatal(err)
	}
	g.send("identify", map[string]string{})
	if _, err := g.readRaw(); websocket.CloseStatus(err) != closeAuthFailed {
		t.Fatalf("another site rode the session cookie into the gateway: %v", err)
	}
}

// ---- encryption keys ----

func TestServerNeverStoresPlaintextAndRejectsMalformedCiphertext(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	st := m.newServer("Soviet")
	general := st.channel(t, "general").ID.String()
	for _, bad := range []string{"plain words", `{"v":1}`, `{"v":2,"iv":"a","ct":"b"}`, strings.Repeat("x", maxContentLen+1)} {
		if status, _ := m.do("POST", "/channels/"+general+"/messages", map[string]any{"content": bad}, nil); status != http.StatusBadRequest {
			t.Fatalf("accepted malformed ciphertext %.20q: %d", bad, status)
		}
	}
	if status, _ := m.do("POST", "/servers", map[string]any{"meta": "My Secret Soviet", "roles": []any{map[string]any{"meta": meta("c")}}}, nil); status != http.StatusBadRequest {
		t.Fatalf("plaintext server name accepted: %d", status)
	}
}

func TestMessagesNeedTheCurrentKeyGeneration(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	st := m.newServer("Soviet")
	var c store.Channel
	m.must(http.StatusCreated, "POST", "/servers/"+st.ID.String()+"/channels", map[string]any{"kind": "text", "meta": meta("fresh")}, &c)
	if status, raw := m.do("POST", "/channels/"+c.ID.String()+"/messages", map[string]any{"content": content(1, "hi")}, nil); status != http.StatusConflict ||
		!strings.Contains(raw, "no_keys") {
		t.Fatalf("message without any key: %d %s", status, raw)
	}
	m.rotate(c.ID)
	if status, raw := m.do("POST", "/channels/"+c.ID.String()+"/messages", map[string]any{"content": content(7, "hi")}, nil); status != http.StatusConflict ||
		!strings.Contains(raw, "stale_epoch") {
		t.Fatalf("message under a wrong generation: %d %s", status, raw)
	}
	m.post(c.ID, "hi", nil)
}

func TestRotationMustIncludeEveryViewerAndOneWins(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	guest := h.register("")
	guest.join(owner.invite(st))
	general := st.channel(t, "general").ID
	ks := owner.keys(general)
	partial := map[string]any{"epoch": ks.Epoch + 1, "rotate": true, "keys": []map[string]any{{"user_id": owner.ID, "wrapped": "x"}}}
	if status, raw := owner.do("POST", "/channels/"+general.String()+"/keys", partial, nil); status != http.StatusConflict ||
		!strings.Contains(raw, "viewers_changed") {
		t.Fatalf("a rotation leaving a member out was accepted: %d %s", status, raw)
	}
	owner.rotate(general)
	// A second rotation built on the old generation must lose.
	stale := map[string]any{"epoch": ks.Epoch + 1, "rotate": true, "keys": []map[string]any{{"user_id": owner.ID, "wrapped": "x"}, {"user_id": guest.ID, "wrapped": "y"}}}
	if status, _ := guest.do("POST", "/channels/"+general.String()+"/keys", stale, nil); status != http.StatusConflict {
		t.Fatalf("a stale rotation won: %d", status)
	}
}

func TestNewMembersReceiveKeysFromHolders(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	general := st.channel(t, "general").ID
	og := owner.connect()
	guest := h.register("")
	guest.join(owner.invite(st))
	gg := guest.connect()

	var req KeyRequest
	for req.Scope != "channel" || req.ID != general {
		if err := json.Unmarshal(og.expect("keys.request"), &req); err != nil {
			t.Fatal(err)
		}
	}
	if len(req.UserIDs) != 1 || req.UserIDs[0] != guest.ID || req.Epochs[0] != 1 {
		t.Fatalf("bad request: %+v", req)
	}
	if ks := guest.keys(general); len(ks.Keys) != 0 || ks.Viewers != nil {
		t.Fatalf("a newcomer without the key must not see who holds it: %+v", ks)
	}
	if status, _ := guest.do("POST", "/channels/"+general.String()+"/keys", map[string]any{"epoch": 1, "keys": []map[string]any{{"user_id": guest.ID, "wrapped": "forged"}}}, nil); status != http.StatusForbidden {
		t.Fatalf("someone without the key shared it: %d", status)
	}
	owner.must(http.StatusNoContent, "POST", "/channels/"+general.String()+"/keys", map[string]any{
		"epoch": 1, "keys": []map[string]any{{"user_id": guest.ID, "wrapped": "epoch1-for-guest"}},
	}, nil)
	gg.expect("keys.available")
	if ks := guest.keys(general); len(ks.Keys) != 1 || ks.Keys[0].Wrapped != "epoch1-for-guest" || ks.Keys[0].SenderID != owner.ID {
		t.Fatalf("guest's keys: %+v", ks)
	}
	guest.post(general, "hello with my key", nil)

	// The server key reaches newcomers the same way.
	var sk struct {
		Missing []id.ID `json:"missing"`
	}
	owner.must(http.StatusOK, "GET", "/servers/"+st.ID.String()+"/keys", nil, &sk)
	if len(sk.Missing) != 1 || sk.Missing[0] != guest.ID {
		t.Fatalf("server key missing list: %+v", sk)
	}
}

func TestPendingKeyRequestsReachHoldersWhenTheyConnect(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	guest := h.register("")
	guest.join(owner.invite(st))
	ready := owner.connect().ready
	found := false
	for _, req := range ready.PendingKeys {
		found = found || (req.Scope == "channel" && len(req.UserIDs) == 1 && req.UserIDs[0] == guest.ID)
	}
	if !found {
		t.Fatalf("an offline holder must learn of requests on connect: %+v", ready.PendingKeys)
	}
}

func TestLosingAccessForcesANewKey(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	general := st.channel(t, "general").ID
	guest := h.register("")
	guest.join(owner.invite(st))
	owner.must(http.StatusNoContent, "POST", "/channels/"+general.String()+"/keys", map[string]any{
		"epoch": 1, "keys": []map[string]any{{"user_id": guest.ID, "wrapped": "k"}},
	}, nil)
	owner.must(http.StatusNoContent, "DELETE", fmt.Sprintf("/servers/%s/members/%s", st.ID, guest.ID), nil, nil)

	ks := owner.keys(general)
	if !ks.Rotate {
		t.Fatal("a departed holder must flag the key for replacement")
	}
	if status, raw := owner.do("POST", "/channels/"+general.String()+"/messages", map[string]any{"content": content(ks.Epoch, "secret")}, nil); status != http.StatusConflict ||
		!strings.Contains(raw, "rotate_keys") {
		t.Fatalf("message under a key the expelled member holds: %d %s", status, raw)
	}
	owner.rotate(general)
	owner.post(general, "now private again", nil)
	if owner.keys(general).Rotate {
		t.Fatal("rotation should clear the flag")
	}
}

func TestHistoryCanBeHiddenFromNewcomers(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	general := st.channel(t, "general").ID
	owner.rotate(general) // generation 2; generation 1 is now history
	owner.must(http.StatusNoContent, "PATCH", "/servers/"+st.ID.String(), map[string]any{"history_visible": false}, nil)
	guest := h.register("")
	guest.join(owner.invite(st))
	share := func(epoch int) int {
		status, _ := owner.do("POST", "/channels/"+general.String()+"/keys", map[string]any{
			"epoch": epoch, "keys": []map[string]any{{"user_id": guest.ID, "wrapped": "k"}},
		}, nil)
		return status
	}
	if got := share(1); got != http.StatusForbidden {
		t.Fatalf("old key shared despite hidden history: %d", got)
	}
	if got := share(2); got != http.StatusNoContent {
		t.Fatalf("current key not shareable: %d", got)
	}
}

func TestKeyResetDropsOldCopies(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	st := m.newServer("Soviet")
	general := st.channel(t, "general").ID
	signKey, dhKey := newIdentity(t)
	reset := map[string]any{"auth_key": m.AuthKey, "sign_key": signKey, "dh_key": dhKey, "bundle": `{"v":1}`}
	m.must(http.StatusNoContent, "PUT", "/users/@me/keys", reset, nil)
	if ks := m.keys(general); len(ks.Keys) != 0 {
		t.Fatalf("keys sealed to the old identity survived: %+v", ks.Keys)
	}
	var u store.User
	m.must(http.StatusOK, "GET", "/users/"+m.ID.String(), nil, &u)
	if u.SignKey != signKey || u.DHKey != dhKey {
		t.Fatal("new identity not published")
	}
}

// ---- servers, gates and permissions ----

func TestJoinGateWithPassword(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	owner.must(http.StatusNoContent, "PUT", "/servers/"+st.ID.String()+"/gate", map[string]any{"mode": "password", "password": "hammer"}, nil)
	code := owner.invite(st)
	var preview map[string]any
	h.call("", "GET", "/api/v1/invites/"+code, nil, &preview)
	if preview["gate"] != "password" {
		t.Fatalf("preview must announce the gate: %v", preview)
	}
	guest := h.register("")
	if status, raw := guest.do("POST", "/invites/"+code, map[string]any{}, nil); status != http.StatusForbidden || !strings.Contains(raw, "gate_required") {
		t.Fatalf("joined without the password: %d %s", status, raw)
	}
	if status, _ := guest.do("POST", "/invites/"+code, map[string]any{"password": "sickle"}, nil); status != http.StatusForbidden {
		t.Fatalf("joined with a wrong password: %d", status)
	}
	guest.must(http.StatusOK, "POST", "/invites/"+code, map[string]any{"password": "hammer"}, nil)
}

func TestJoinGateWithRotatingCode(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	owner.must(http.StatusNoContent, "PUT", "/servers/"+st.ID.String()+"/gate", map[string]any{"mode": "rotating", "period": 60}, nil)
	var gate struct {
		Mode      string `json:"mode"`
		Code      string `json:"code"`
		Remaining int    `json:"remaining"`
	}
	owner.must(http.StatusOK, "GET", "/servers/"+st.ID.String()+"/gate", nil, &gate)
	if gate.Mode != "rotating" || len(gate.Code) != 6 || gate.Remaining < 1 || gate.Remaining > 60 {
		t.Fatalf("gate status: %+v", gate)
	}
	guest := h.register("")
	code := owner.invite(st)
	wrong := "000000"
	if gate.Code == wrong {
		wrong = "111111"
	}
	if status, _ := guest.do("POST", "/invites/"+code, map[string]any{"password": wrong}, nil); status != http.StatusForbidden {
		t.Fatalf("joined with a wrong code: %d", status)
	}
	guest.must(http.StatusOK, "POST", "/invites/"+code, map[string]any{"password": gate.Code}, nil)
	outsider := h.register("")
	if status, _ := outsider.do("GET", "/servers/"+st.ID.String()+"/gate", nil, nil); status != http.StatusNotFound {
		t.Fatalf("a non-member read the gate code: %d", status)
	}
}

func TestNobodyCanGrantRightsTheyLack(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	manager := h.register("")
	manager.join(owner.invite(st))
	sid := st.ID.String()
	var clerk store.Role
	owner.must(http.StatusCreated, "POST", "/servers/"+sid+"/roles", map[string]any{"meta": meta("Clerk"), "permissions": perm.ManageRoles}, &clerk)
	owner.must(http.StatusOK, "PATCH", fmt.Sprintf("/servers/%s/members/%s", sid, manager.ID), map[string]any{"roles": []id.ID{clerk.ID}}, nil)

	if status, _ := manager.do("POST", "/servers/"+sid+"/roles", map[string]any{"meta": meta("Coup"), "permissions": perm.Administrator}, nil); status != http.StatusForbidden {
		t.Fatalf("escalation via new role: got %d", status)
	}
	politburo := st.role(t, "Politburo")
	if status, _ := manager.do("PATCH", fmt.Sprintf("/servers/%s/members/%s", sid, manager.ID), map[string]any{"roles": []id.ID{clerk.ID, politburo.ID}}, nil); status != http.StatusForbidden {
		t.Fatalf("escalation via role grant: got %d", status)
	}
	if status, _ := manager.do("PATCH", fmt.Sprintf("/servers/%s/roles/%s", sid, clerk.ID), map[string]any{"permissions": perm.ManageRoles | perm.Administrator}, nil); status != http.StatusForbidden {
		t.Fatalf("editing own role upward: got %d", status)
	}
	order := []id.ID{st.role(t, "Commissar").ID, politburo.ID, clerk.ID}
	if status, _ := manager.do("PUT", "/servers/"+sid+"/roles/order", map[string]any{"roles": order}, nil); status != http.StatusForbidden {
		t.Fatalf("climbing the hierarchy: got %d", status)
	}
	general := st.channel(t, "general").ID
	if status, _ := manager.do("PUT", fmt.Sprintf("/channels/%s/overwrites/member/%s", general, manager.ID), map[string]any{"allow": perm.ManageMessages}, nil); status != http.StatusForbidden {
		t.Fatalf("escalation via overwrite: got %d", status)
	}
}

func TestHierarchyProtectsSeniors(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	sid := st.ID.String()
	senior := h.register("")
	junior := h.register("")
	code := owner.invite(st)
	senior.join(code)
	junior.join(code)
	commissar := st.role(t, "Commissar")
	owner.must(http.StatusOK, "PATCH", fmt.Sprintf("/servers/%s/members/%s", sid, senior.ID), map[string]any{"roles": []id.ID{commissar.ID}}, nil)
	owner.must(http.StatusNoContent, "PATCH", fmt.Sprintf("/servers/%s/roles/%s", sid, commissar.ID), map[string]any{"permissions": perm.KickMembers | perm.BanMembers}, nil)
	if status, _ := senior.do("DELETE", fmt.Sprintf("/servers/%s/members/%s", sid, owner.ID), nil, nil); status != http.StatusForbidden {
		t.Fatalf("kicking the owner: got %d", status)
	}
	if status, _ := junior.do("DELETE", fmt.Sprintf("/servers/%s/members/%s", sid, senior.ID), nil, nil); status != http.StatusForbidden {
		t.Fatalf("junior kicking senior: got %d", status)
	}
	senior.must(http.StatusNoContent, "DELETE", fmt.Sprintf("/servers/%s/members/%s", sid, junior.ID), nil, nil)
}

func TestHiddenChannelsStayHidden(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	var secret store.Channel
	owner.must(http.StatusCreated, "POST", "/servers/"+st.ID.String()+"/channels", map[string]any{"kind": "text", "meta": meta("secret")}, &secret)
	owner.must(http.StatusNoContent, "PUT", fmt.Sprintf("/channels/%s/overwrites/role/%s", secret.ID, st.ID), map[string]any{"deny": perm.ViewChannel}, nil)
	owner.rotate(secret.ID)
	reader := h.register("")
	reader.join(owner.invite(st))
	g := reader.connect()
	for _, c := range g.ready.Servers[0].Channels {
		if c.ID == secret.ID {
			t.Fatal("hidden channel listed in ready")
		}
	}
	owner.post(secret.ID, "the plan", nil)
	g.never("message.create")
	for _, path := range []string{"/messages", "/keys", "/pins"} {
		if status, _ := reader.do("GET", "/channels/"+secret.ID.String()+path, nil, nil); status != http.StatusNotFound {
			t.Fatalf("hidden channel %s: %d", path, status)
		}
	}
}

func TestMentionsAreCheckedAndCounted(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	guest := h.register("")
	guest.join(owner.invite(st))
	general := st.channel(t, "general").ID
	owner.must(http.StatusNoContent, "POST", "/channels/"+general.String()+"/keys", map[string]any{
		"epoch": 1, "keys": []map[string]any{{"user_id": guest.ID, "wrapped": "k"}},
	}, nil)
	g := guest.connect()
	plain := guest.post(general, "listen", map[string]any{"mention_everyone": true})
	if plain.MentionEveryone {
		t.Fatal("ordinary members cannot address everyone")
	}
	stranger := h.register("")
	ping := owner.post(general, "look", map[string]any{"mentions": []id.ID{guest.ID, stranger.ID}})
	if len(ping.Mentions) != 1 || ping.Mentions[0] != guest.ID {
		t.Fatalf("mentions must be limited to people who can see the channel: %+v", ping.Mentions)
	}
	g.expect("mention.create")
	mentions := 0
	for _, rs := range guest.connect().ready.ReadStates {
		if rs.ChannelID == general {
			mentions = rs.Mentions
		}
	}
	if mentions != 1 {
		t.Fatalf("unread mentions = %d", mentions)
	}
}

// ---- messages ----

func TestEncryptedReactions(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	general := st.channel(t, "general").ID
	guest := h.register("")
	guest.join(owner.invite(st))
	owner.must(http.StatusNoContent, "POST", "/channels/"+general.String()+"/keys", map[string]any{
		"epoch": 1, "keys": []map[string]any{{"user_id": guest.ID, "wrapped": "k"}},
	}, nil)
	msg := owner.post(general, "vote", nil)
	og := owner.connect()
	path := fmt.Sprintf("/channels/%s/messages/%s/reactions", general, msg.ID)
	var reaction store.Reaction
	guest.must(http.StatusCreated, "POST", path, map[string]any{"content": content(1, "star")}, &reaction)
	og.expect("reaction.add")
	if status, _ := guest.do("POST", path, map[string]any{"content": "⭐"}, nil); status != http.StatusBadRequest {
		t.Fatalf("plaintext reaction accepted: %d", status)
	}
	if status, _ := owner.do("DELETE", path+"/"+reaction.ID.String(), nil, nil); status != http.StatusNoContent {
		t.Fatalf("the owner (who may moderate) could not remove it: %d", status)
	}
	guest.must(http.StatusCreated, "POST", path, map[string]any{"content": content(1, "star")}, &reaction)
	third := h.register("")
	third.join(owner.invite(st))
	if status, _ := third.do("DELETE", path+"/"+reaction.ID.String(), nil, nil); status != http.StatusForbidden {
		t.Fatalf("removing someone else's reaction: %d", status)
	}
	var list []store.Message
	owner.must(http.StatusOK, "GET", "/channels/"+general.String()+"/messages", nil, &list)
	var reacted store.Message
	for _, m := range list {
		if m.ID == msg.ID {
			reacted = m
		}
	}
	if r := reacted.Reactions; len(r) != 1 || r[0].UserID != guest.ID {
		t.Fatalf("reactions in history: %+v", r)
	}
}

func TestDisappearingMessages(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	general := st.channel(t, "general").ID
	if status, _ := owner.do("PATCH", "/channels/"+general.String(), map[string]any{"ttl_seconds": 7}, nil); status != http.StatusBadRequest {
		t.Fatalf("arbitrary timers must be refused: %d", status)
	}
	owner.must(http.StatusNoContent, "PATCH", "/channels/"+general.String(), map[string]any{"ttl_seconds": 300}, nil)
	msg := owner.post(general, "this will vanish", nil)
	if msg.ExpiresAt == 0 {
		t.Fatal("messages in a timed channel must carry an expiry")
	}
	g := owner.connect()
	// Pretend the time has passed rather than waiting five minutes.
	if _, err := h.srv.db.ExecForTest(`UPDATE messages SET expires_at = 1 WHERE id = ?`, msg.ID); err != nil {
		t.Fatal(err)
	}
	h.srv.sweepExpired()
	var deleted struct {
		ID      id.ID `json:"id"`
		Expired bool  `json:"expired"`
	}
	for deleted.ID != msg.ID {
		if err := json.Unmarshal(g.expect("message.delete"), &deleted); err != nil {
			t.Fatal(err)
		}
	}
	var list []store.Message
	owner.must(http.StatusOK, "GET", "/channels/"+general.String()+"/messages", nil, &list)
	for _, m := range list {
		if m.ID == msg.ID {
			t.Fatal("an expired message is still listed")
		}
	}
}

func TestPaginationWalksBackwards(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	general := st.channel(t, "general").ID
	base := "/channels/" + general.String() + "/messages"
	ids := make([]id.ID, 7)
	for i := range ids {
		ids[i] = owner.post(general, fmt.Sprint(i), nil).ID
	}
	var page []store.Message
	owner.must(http.StatusOK, "GET", base+"?limit=3", nil, &page)
	if len(page) != 3 || page[2].ID != ids[6] {
		t.Fatalf("latest page: %+v", page)
	}
	owner.must(http.StatusOK, "GET", fmt.Sprintf("%s?limit=3&before=%s", base, page[0].ID), nil, &page)
	if len(page) != 3 || page[0].ID != ids[1] || page[2].ID != ids[3] {
		t.Fatalf("older page: %+v", page)
	}
}

func TestGatewayResumeReplaysMissedEvents(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	general := st.channel(t, "general").ID
	g := owner.connect()
	owner.post(general, "before", nil)
	g.expect("message.create")
	seq, session := g.seq, g.ready.SessionID
	g.ws.CloseNow()
	<-g.closed
	time.Sleep(100 * time.Millisecond)
	for i := range 3 {
		owner.post(general, fmt.Sprintf("missed %d", i), nil)
	}
	r := h.newGW(nil)
	if hello, err := r.readRaw(); err != nil || hello.Op != "hello" {
		t.Fatalf("hello: %+v %v", hello, err)
	}
	r.send("resume", map[string]any{"token": owner.Token, "session_id": session, "seq": seq})
	go r.pump()
	r.expect("resumed")
	for i := range 3 {
		var m store.Message
		if err := json.Unmarshal(r.expect("message.create"), &m); err != nil {
			t.Fatal(err)
		}
		if metaLabel(m.Content) != fmt.Sprintf("missed %d", i) {
			t.Fatalf("out of order replay: %q", m.Content)
		}
	}
}

func TestResumeRefusesAnotherUsersSession(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	victim := h.register("")
	thief := h.register("")
	session := victim.connect().ready.SessionID
	r := h.newGW(nil)
	if _, err := r.readRaw(); err != nil {
		t.Fatal(err)
	}
	r.send("resume", map[string]any{"token": thief.Token, "session_id": session, "seq": 0})
	if e, err := r.readRaw(); err != nil || e.Op != "invalid_session" {
		t.Fatalf("expected invalid_session, got %+v %v", e, err)
	}
}

func TestDMsRespectBlocksAndContacts(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	a := h.register("")
	st := a.newServer("Soviet")
	b := h.register("")
	b.join(a.invite(st))
	stranger := h.register("")
	if status, _ := stranger.do("POST", "/dms", map[string]any{"recipients": []id.ID{a.ID}}, nil); status != http.StatusForbidden {
		t.Fatalf("cold-messaging a stranger: got %d", status)
	}
	var dm store.Channel
	a.must(http.StatusCreated, "POST", "/dms", map[string]any{"recipients": []id.ID{b.ID}}, &dm)
	if !dm.Perms.Has(perm.SendMessages) {
		t.Fatalf("DM rights missing: %b", dm.Perms)
	}
	a.rotate(dm.ID)
	if ks := b.keys(dm.ID); len(ks.Keys) != 1 {
		t.Fatal("both participants should receive the first key")
	}
	a.post(dm.ID, "hi", nil)
	if status, _ := stranger.do("GET", "/channels/"+dm.ID.String()+"/messages", nil, nil); status != http.StatusNotFound {
		t.Fatalf("outsider reading a DM: got %d", status)
	}
	b.must(http.StatusNoContent, "PUT", "/relationships/"+a.ID.String(), map[string]string{"kind": "blocked"}, nil)
	if status, _ := a.do("POST", "/channels/"+dm.ID.String()+"/messages", map[string]any{"content": content(1, "still there?")}, nil); status != http.StatusForbidden {
		t.Fatalf("message to someone who blocked you: got %d", status)
	}
}

// ---- files ----

func uploadFile(t *testing.T, m *member, filename, query string, data []byte) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest("POST", m.h.ts.URL+"/api/v1/uploads?filename="+filename+"&"+query, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+m.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func fetchMedia(t *testing.T, m *member, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest("GET", m.h.ts.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.Token != "" {
		req.Header.Set("Authorization", "Bearer "+m.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

var pngHeader = func() []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		panic(err)
	}
	return buf.Bytes()
}()

func TestEncryptedUploadsAreOpaqueAndFollowChannelAccess(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	general := st.channel(t, "general").ID
	status, up := uploadFile(t, owner, "holiday-plans.png", "kind=message", []byte("ciphertext bytes"))
	if status != http.StatusCreated {
		t.Fatalf("upload: %d", status)
	}
	if up["filename"] != "encrypted" || up["mime"] != "application/octet-stream" {
		t.Fatalf("the server must not record real names or types: %+v", up)
	}
	url := up["url"].(string)
	outsider := h.register("")
	if got := fetchMedia(t, outsider, url).StatusCode; got != http.StatusNotFound {
		t.Fatalf("unattached file visible to others: %d", got)
	}
	owner.post(general, "see attached", map[string]any{"attachments": []any{up["id"]}})
	resp := fetchMedia(t, owner, url)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/octet-stream" ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment") || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("served unsafely: %d %v", resp.StatusCode, resp.Header)
	}
	if got := fetchMedia(t, outsider, url).StatusCode; got != http.StatusNotFound {
		t.Fatalf("non-member can fetch: %d", got)
	}
}

func TestServerIconsAreMembersOnly(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	status, up := uploadFile(t, owner, "icon", "kind=server&server="+st.ID.String(), []byte("encrypted icon"))
	if status != http.StatusCreated {
		t.Fatalf("icon upload: %d", status)
	}
	owner.must(http.StatusNoContent, "PATCH", "/servers/"+st.ID.String(), map[string]any{"icon_attachment": up["id"]}, nil)
	if got := fetchMedia(t, owner, up["url"].(string)).StatusCode; got != http.StatusOK {
		t.Fatalf("member cannot fetch icon: %d", got)
	}
	if got := fetchMedia(t, h.register(""), up["url"].(string)).StatusCode; got != http.StatusNotFound {
		t.Fatalf("outsider fetched icon: %d", got)
	}
	guest := h.register("")
	guest.join(owner.invite(st))
	if status, _ := uploadFile(t, guest, "icon", "kind=server&server="+st.ID.String(), []byte("x")); status != http.StatusForbidden {
		t.Fatalf("member without rights uploaded an icon: %d", status)
	}
}

func TestProfileCustomisation(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	m := h.register("")
	status, avatar := uploadFile(t, m, "me.png", "kind=public", pngHeader)
	if status != http.StatusCreated {
		t.Fatalf("avatar: %d", status)
	}
	status, banner := uploadFile(t, m, "banner.png", "kind=public", pngHeader)
	if status != http.StatusCreated {
		t.Fatalf("banner: %d", status)
	}
	if status, _ := uploadFile(t, m, "fake.png", "kind=public", []byte("<svg onload=alert(1)>")); status != http.StatusBadRequest {
		t.Fatalf("non-image accepted as public image: %d", status)
	}
	var account store.Account
	m.must(http.StatusOK, "PATCH", "/users/@me", map[string]any{
		"avatar": avatar["url"], "banner": banner["url"], "banner_color": 0xC8102E, "accent_color": 0xD9A400,
		"pronouns": "they/them", "bio": "Five-year plans, on schedule.", "custom_status": "Inking the presses",
	}, &account)
	if account.Banner != banner["url"] || account.AccentColor != 0xD9A400 || account.Pronouns != "they/them" {
		t.Fatalf("profile not saved: %+v", account)
	}
	if status, _ := m.do("PATCH", "/users/@me", map[string]any{"accent_color": 0x1000000}, nil); status != http.StatusBadRequest {
		t.Fatalf("out-of-range colour accepted: %d", status)
	}
	other := h.register("")
	if status, _ := other.do("PATCH", "/users/@me", map[string]any{"banner": banner["url"]}, nil); status != http.StatusBadRequest {
		t.Fatalf("used someone else's banner: %d", status)
	}
}

// ---- voice and watching together ----

func TestVoiceJoinNeedsPermissionAndCleansUpOnBan(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	hall := st.channel(t, "Main Hall")
	guest := h.register("")
	guest.join(owner.invite(st))
	og := owner.connect()
	gg := guest.connect()
	owner.must(http.StatusNoContent, "PUT", fmt.Sprintf("/channels/%s/overwrites/member/%s", hall.ID, guest.ID), map[string]any{"deny": perm.VoiceConnect}, nil)
	gg.send("voice_join", map[string]any{"channel_id": hall.ID})
	gg.expect("op.error")
	owner.must(http.StatusNoContent, "DELETE", fmt.Sprintf("/channels/%s/overwrites/member/%s", hall.ID, guest.ID), nil, nil)
	gg.send("voice_join", map[string]any{"channel_id": hall.ID, "self_mute": true})
	gg.expect("voice.ready")
	var state VoiceState
	if err := json.Unmarshal(og.expect("voice.state"), &state); err != nil {
		t.Fatal(err)
	}
	if state.UserID != guest.ID || !state.SelfMute {
		t.Fatalf("bad state: %+v", state)
	}
	owner.must(http.StatusNoContent, "PUT", fmt.Sprintf("/servers/%s/bans/%s", st.ID, guest.ID), map[string]string{}, nil)
	gg.expect("voice.ended")
	h.srv.voice.mu.Lock()
	remaining := len(h.srv.voice.byUser)
	h.srv.voice.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("%d stale voice connections", remaining)
	}
}

func TestWatchPartyIsRelayedEncryptedToTheCall(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	hall := st.channel(t, "Main Hall")
	guest := h.register("")
	guest.join(owner.invite(st))
	owner.must(http.StatusNoContent, "POST", "/channels/"+hall.ID.String()+"/keys", map[string]any{
		"epoch": 1, "keys": []map[string]any{{"user_id": guest.ID, "wrapped": "k"}},
	}, nil)
	og := owner.connect()
	gg := guest.connect()
	og.send("watch_set", map[string]any{"channel_id": hall.ID, "blob": content(1, "film")})
	og.expect("op.error") // not in the call yet
	og.send("voice_join", map[string]any{"channel_id": hall.ID})
	og.expect("voice.ready")
	og.send("watch_set", map[string]any{"channel_id": hall.ID, "blob": "https://example.com/plain.mp4"})
	og.expect("op.error") // must be encrypted
	og.send("watch_set", map[string]any{"channel_id": hall.ID, "blob": content(1, "film")})
	var state watchState
	if err := json.Unmarshal(gg.expect("watch.state"), &state); err != nil {
		t.Fatal(err)
	}
	if state.By != owner.ID || metaLabel(state.Blob) != "film" {
		t.Fatalf("watch state: %+v", state)
	}
	gg.send("voice_join", map[string]any{"channel_id": hall.ID})
	var ready struct {
		Watch *watchState `json:"watch"`
	}
	if err := json.Unmarshal(gg.expect("voice.ready"), &ready); err != nil {
		t.Fatal(err)
	}
	if ready.Watch == nil || metaLabel(ready.Watch.Blob) != "film" {
		t.Fatal("late joiners must receive what is playing")
	}
}

func TestDMCallRingsTheOtherPerson(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	a := h.register("")
	st := a.newServer("Soviet")
	b := h.register("")
	b.join(a.invite(st))
	var dm store.Channel
	a.must(http.StatusCreated, "POST", "/dms", map[string]any{"recipients": []id.ID{b.ID}}, &dm)
	ag := a.connect()
	bg := b.connect()
	ag.send("voice_join", map[string]any{"channel_id": dm.ID})
	ag.expect("voice.ready")
	bg.expect("call.ring")
	ag.send("voice_leave", nil)
	bg.expect("call.end")
}

func TestOwnerCannotLeaveButCanTransferOffice(t *testing.T) {
	h := newHarness(t, RegistrationOpen)
	owner := h.register("")
	st := owner.newServer("Soviet")
	heir := h.register("")
	heir.join(owner.invite(st))
	if status, _ := owner.do("POST", "/servers/"+st.ID.String()+"/leave", map[string]any{}, nil); status != http.StatusBadRequest {
		t.Fatalf("owner leaving: got %d", status)
	}
	if status, _ := heir.do("PATCH", "/servers/"+st.ID.String(), map[string]any{"owner_id": heir.ID}, nil); status != http.StatusForbidden {
		t.Fatalf("seizing ownership: got %d", status)
	}
	owner.must(http.StatusNoContent, "PATCH", "/servers/"+st.ID.String(), map[string]any{"owner_id": heir.ID}, nil)
	owner.must(http.StatusNoContent, "POST", "/servers/"+st.ID.String()+"/leave", map[string]any{}, nil)
	heir.must(http.StatusNoContent, "DELETE", "/servers/"+st.ID.String(), nil, nil)
}
