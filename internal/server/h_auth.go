package server

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"pravda/internal/id"
	"pravda/internal/store"
)

// Sign-in works like a password manager's. The client stretches the password
// with PBKDF2 and splits the result: one half is sent here as the "auth key"
// and hashed again with Argon2id; the other half never leaves the device and
// unseals the user's private keys. The server therefore never sees anything
// that could decrypt a message.

const (
	defaultKDFIterations = 600_000
	minKDFIterations     = 100_000
	maxKDFIterations     = 10_000_000
	mfaTicketLifetime    = 5 * time.Minute
	mfaTicketAttempts    = 5
	recoveryCodeCount    = 10
)

// Session stages.
const (
	stageFull   = "full"
	stageEnroll = "enroll"
)

// mfaTickets remembers who passed the password step and may now enter a code.
type mfaTickets struct {
	mu      sync.Mutex
	tickets map[string]*mfaTicket
}

type mfaTicket struct {
	user     id.ID
	expires  time.Time
	attempts int
}

func (t *mfaTickets) issue(user id.ID) (string, error) {
	token, err := randomToken(24)
	if err != nil {
		return "", err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tickets == nil {
		t.tickets = map[string]*mfaTicket{}
	}
	t.tickets[token] = &mfaTicket{user: user, expires: time.Now().Add(mfaTicketLifetime)}
	return token, nil
}

// attempt returns the ticket's user, counting the attempt. Exhausted or
// expired tickets are forgotten.
func (t *mfaTickets) attempt(token string) (id.ID, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	tk := t.tickets[token]
	if tk == nil {
		return 0, false
	}
	tk.attempts++
	if time.Now().After(tk.expires) || tk.attempts > mfaTicketAttempts {
		delete(t.tickets, token)
		return 0, false
	}
	return tk.user, true
}

func (t *mfaTickets) consume(token string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.tickets, token)
}

func (t *mfaTickets) sweep() {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for k, tk := range t.tickets {
		if now.After(tk.expires) {
			delete(t.tickets, k)
		}
	}
}

func decodeAuthKey(s string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) != 32 {
		return nil, fail(http.StatusBadRequest, "bad_auth_key", "Malformed credentials.")
	}
	return raw, nil
}

func (s *Server) prelogin(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Username string `json:"username"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	if !s.loginLimit.allow("pre:" + s.clientIP(r)) {
		return errRate
	}
	creds, err := s.db.CredentialsFor(r.Context(), body.Username)
	if errors.Is(err, store.ErrNotFound) {
		// Answer for unknown names with a stable made-up salt, so the
		// response does not reveal who has an account.
		writeJSON(w, http.StatusOK, map[string]any{
			"kdf_salt":       base64.StdEncoding.EncodeToString(s.secret.derive("salt:"+strings.ToLower(body.Username), 16)),
			"kdf_iterations": defaultKDFIterations,
		})
		return nil
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"kdf_salt": creds.KDFSalt, "kdf_iterations": creds.KDFIterations})
	return nil
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Username       string `json:"username"`
		DisplayName    string `json:"display_name"`
		AuthKey        string `json:"auth_key"`
		KDFSalt        string `json:"kdf_salt"`
		KDFIterations  int    `json:"kdf_iterations"`
		SignKey        string `json:"sign_key"`
		DHKey          string `json:"dh_key"`
		Bundle         string `json:"bundle"`
		RecoveryBundle string `json:"recovery_bundle"`
		RecoveryAuth   string `json:"recovery_auth"`
		Invite         string `json:"invite"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if !s.registerLimit.allow(s.clientIP(r)) {
		return errRate
	}
	if !usernamePattern.MatchString(body.Username) {
		return fail(http.StatusBadRequest, "invalid_username", "Usernames are 2 to 32 letters, digits, dots, dashes or underscores.")
	}
	authKey, err := decodeAuthKey(body.AuthKey)
	if err != nil {
		return err
	}
	salt, err := base64.StdEncoding.DecodeString(body.KDFSalt)
	if err != nil || len(salt) < 16 || len(salt) > 64 {
		return fail(http.StatusBadRequest, "bad_kdf", "Malformed key derivation settings.")
	}
	if body.KDFIterations < minKDFIterations || body.KDFIterations > maxKDFIterations {
		return fail(http.StatusBadRequest, "bad_kdf", "Unsupported key derivation strength.")
	}
	if !validPublicKey(body.SignKey) || !validPublicKey(body.DHKey) {
		return fail(http.StatusBadRequest, "bad_keys", "Malformed identity keys.")
	}
	if body.Bundle == "" || len(body.Bundle) > maxBundleLen || len(body.RecoveryBundle) > maxBundleLen {
		return fail(http.StatusBadRequest, "bad_keys", "Malformed key bundle.")
	}
	if body.DisplayName == "" {
		body.DisplayName = body.Username
	}
	display, err := cleanLine("display_name", body.DisplayName, 1, 32)
	if err != nil {
		return err
	}
	count, err := s.db.UserCount(ctx)
	if err != nil {
		return err
	}
	if body.Invite != "" {
		invite, err := s.db.GetInvite(ctx, body.Invite)
		if err != nil || !invite.Usable() {
			return fail(http.StatusBadRequest, "bad_invite", "That invitation is not valid.")
		}
	}
	if count > 0 {
		switch s.cfg.Registration {
		case RegistrationClosed:
			return fail(http.StatusForbidden, "registration_closed", "This instance is not accepting new accounts.")
		case RegistrationInvite:
			if body.Invite == "" {
				return fail(http.StatusForbidden, "invite_required", "You need an invitation to join this instance.")
			}
		}
	}
	hash, err := s.hashPassword(ctx, base64.StdEncoding.EncodeToString(authKey))
	if err != nil {
		return err
	}
	recoveryHash := ""
	if body.RecoveryAuth != "" {
		recoveryKey, err := decodeAuthKey(body.RecoveryAuth)
		if err != nil || body.RecoveryBundle == "" {
			return fail(http.StatusBadRequest, "bad_recovery", "Malformed recovery material.")
		}
		if recoveryHash, err = s.hashPassword(ctx, base64.StdEncoding.EncodeToString(recoveryKey)); err != nil {
			return err
		}
	}
	account, err := s.db.CreateUser(ctx, store.NewUser{
		Username: body.Username, DisplayName: display, AuthHash: hash, KDFSalt: body.KDFSalt, KDFIterations: body.KDFIterations,
		SignKey: body.SignKey, DHKey: body.DHKey, KeyBundle: body.Bundle, RecoveryBundle: body.RecoveryBundle, RecoveryAuth: recoveryHash,
	})
	if errors.Is(err, store.ErrConflict) {
		return fail(http.StatusConflict, "username_taken", "That username is taken.")
	}
	if err != nil {
		return err
	}
	stage := stageFull
	if s.cfg.Require2FA {
		stage = stageEnroll
	}
	token, err := s.startLogin(w, r, account.ID, stage)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": account, "token": token, "stage": stage})
	return nil
}

// dummyHash burns the same time as a real check for unknown usernames.
const dummyHash = "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func (s *Server) checkAuthKey(ctx context.Context, authKeyB64, hash string) (bool, error) {
	authKey, err := decodeAuthKey(authKeyB64)
	if err != nil {
		return false, err
	}
	return s.verifyPassword(ctx, base64.StdEncoding.EncodeToString(authKey), hash)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Username string `json:"username"`
		AuthKey  string `json:"auth_key"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if !s.loginLimit.allow(s.clientIP(r)) || !s.loginLimit.allow("user:"+strings.ToLower(body.Username)) {
		return errRate
	}
	creds, err := s.db.CredentialsFor(ctx, body.Username)
	found := err == nil
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if !found {
		creds.AuthHash = dummyHash
	}
	ok, err := s.checkAuthKey(ctx, body.AuthKey, creds.AuthHash)
	if err != nil {
		return err
	}
	if !found || !ok {
		return fail(http.StatusUnauthorized, "bad_credentials", "Wrong username or password.")
	}
	if creds.TOTPEnabled {
		ticket, err := s.mfa.issue(creds.UserID)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"mfa_required": true, "ticket": ticket})
		return nil
	}
	stage := stageFull
	if s.cfg.Require2FA {
		stage = stageEnroll
	}
	return s.finishLogin(w, r, creds.UserID, stage)
}

func (s *Server) finishLogin(w http.ResponseWriter, r *http.Request, user id.ID, stage string) error {
	ctx := r.Context()
	account, err := s.db.GetAccount(ctx, user)
	if err != nil {
		return err
	}
	bundle, err := s.db.GetKeyBundle(ctx, user)
	if err != nil {
		return err
	}
	token, err := s.startLogin(w, r, user, stage)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": account, "token": token, "stage": stage, "bundle": bundle})
	return nil
}

func (s *Server) loginMFA(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Ticket       string `json:"ticket"`
		Code         string `json:"code"`
		RecoveryCode string `json:"recovery_code"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	user, ok := s.mfa.attempt(body.Ticket)
	if !ok {
		return fail(http.StatusUnauthorized, "ticket_expired", "Sign in again: that attempt expired.")
	}
	if !s.loginLimit.allow("mfa:" + user.String()) {
		return errRate
	}
	wrong := fail(http.StatusUnauthorized, "bad_code", "That code is not right.")
	if body.RecoveryCode != "" {
		used, err := s.db.UseRecoveryCode(ctx, user, hashRecoveryCode(body.RecoveryCode))
		if err != nil {
			return err
		}
		if !used {
			return wrong
		}
	} else {
		if err := s.checkTOTP(ctx, user, body.Code); err != nil {
			return err
		}
	}
	s.mfa.consume(body.Ticket)
	return s.finishLogin(w, r, user, stageFull)
}

// recover starts a password reset with the recovery key and second factor.
// It returns the recovery-sealed bundle so the client can re-seal its keys
// under a new password, and a ticket to finish with.
func (s *Server) recover(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Username     string `json:"username"`
		RecoveryAuth string `json:"recovery_auth"`
		Code         string `json:"code"`
		RecoveryCode string `json:"recovery_code"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if !s.loginLimit.allow(s.clientIP(r)) || !s.loginLimit.allow("recover:"+strings.ToLower(body.Username)) {
		return errRate
	}
	wrong := fail(http.StatusUnauthorized, "bad_recovery", "Those recovery details are not right.")
	info, err := s.db.RecoveryFor(ctx, body.Username)
	found := err == nil && info.AuthHash != ""
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if !found {
		info.AuthHash = dummyHash
	}
	ok, err := s.checkAuthKey(ctx, body.RecoveryAuth, info.AuthHash)
	if err != nil {
		return err
	}
	if !found || !ok {
		return wrong
	}
	if info.TOTPEnabled {
		if body.RecoveryCode != "" {
			used, err := s.db.UseRecoveryCode(ctx, info.UserID, hashRecoveryCode(body.RecoveryCode))
			if err != nil {
				return err
			}
			if !used {
				return wrong
			}
		} else if err := s.checkTOTP(ctx, info.UserID, body.Code); err != nil {
			return err
		}
	}
	ticket, err := s.recovery.issue(info.UserID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ticket": ticket, "recovery_bundle": info.Bundle})
	return nil
}

func (s *Server) recoverComplete(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Ticket        string `json:"ticket"`
		NewAuthKey    string `json:"new_auth_key"`
		KDFSalt       string `json:"kdf_salt"`
		KDFIterations int    `json:"kdf_iterations"`
		Bundle        string `json:"bundle"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	user, ok := s.recovery.attempt(body.Ticket)
	if !ok {
		return fail(http.StatusUnauthorized, "ticket_expired", "Start the recovery again: that attempt expired.")
	}
	newKey, err := decodeAuthKey(body.NewAuthKey)
	if err != nil {
		return err
	}
	if salt, err := base64.StdEncoding.DecodeString(body.KDFSalt); err != nil || len(salt) < 16 {
		return fail(http.StatusBadRequest, "bad_kdf", "Malformed key derivation settings.")
	}
	if body.KDFIterations < minKDFIterations || body.KDFIterations > maxKDFIterations || body.Bundle == "" || len(body.Bundle) > maxBundleLen {
		return fail(http.StatusBadRequest, "bad_kdf", "Malformed key derivation settings.")
	}
	hash, err := s.hashPassword(ctx, base64.StdEncoding.EncodeToString(newKey))
	if err != nil {
		return err
	}
	if err := s.db.ChangePassword(ctx, user, hash, body.KDFSalt, body.KDFIterations, body.Bundle); err != nil {
		return err
	}
	s.recovery.consume(body.Ticket)
	// Whoever had the old password, or any device, loses access now.
	sessions, err := s.db.ListSessions(ctx, user)
	if err != nil {
		return err
	}
	for _, sn := range sessions {
		if err := s.db.DeleteSession(ctx, user, sn.ID); err != nil {
			return err
		}
		s.hub.endAuth(sn.ID)
	}
	stage := stageFull
	if state, err := s.db.GetTOTP(ctx, user); err == nil && !state.Enabled && s.cfg.Require2FA {
		stage = stageEnroll
	}
	account, err := s.db.GetAccount(ctx, user)
	if err != nil {
		return err
	}
	token, err := s.startLogin(w, r, user, stage)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": account, "token": token, "stage": stage})
	return nil
}

// checkTOTP verifies a code against a user's authenticator, refusing reuse.
func (s *Server) checkTOTP(ctx context.Context, user id.ID, code string) error {
	state, err := s.db.GetTOTP(ctx, user)
	if err != nil {
		return err
	}
	if !state.Enabled {
		return fail(http.StatusBadRequest, "no_authenticator", "No authenticator is set up.")
	}
	secret, err := s.secret.open(state.Secret, "totp")
	if err != nil {
		return err
	}
	step, ok := checkCode(secret, code, totpPeriod, totpSkew, time.Now())
	if !ok {
		return fail(http.StatusUnauthorized, "bad_code", "That code is not right.")
	}
	fresh, err := s.db.AdvanceTOTPStep(ctx, user, step)
	if err != nil {
		return err
	}
	if !fresh {
		return fail(http.StatusUnauthorized, "code_used", "That code was already used. Wait for the next one.")
	}
	return nil
}

func (s *Server) totpSetup(w http.ResponseWriter, r *http.Request, auth Auth) error {
	ctx := r.Context()
	account, err := s.db.GetAccount(ctx, auth.User)
	if err != nil {
		return err
	}
	if account.TOTPEnabled && auth.Stage == stageFull {
		// Replacing a working authenticator needs proof of the current one.
		var body struct {
			Code string `json:"code"`
		}
		if err := decode(r, w, &body); err != nil {
			return err
		}
		if err := s.checkTOTP(ctx, auth.User, body.Code); err != nil {
			return err
		}
	}
	secret, err := newSecret()
	if err != nil {
		return err
	}
	sealed, err := s.secret.seal(secret, "totp")
	if err != nil {
		return err
	}
	if err := s.db.SetTOTPPending(ctx, auth.User, sealed); err != nil {
		return err
	}
	issuer := "Pravda"
	if s.cfg.Name != "" && s.cfg.Name != "Pravda" {
		issuer = "Pravda (" + s.cfg.Name + ")"
	}
	uri := otpauthURI(issuer, account.Username, secret)
	image, err := qrDataURI(uri)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"secret": base32NoPad.EncodeToString(secret), "uri": uri, "qr": image})
	return nil
}

func (s *Server) totpEnable(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var body struct {
		Code string `json:"code"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if !s.loginLimit.allow("mfa:" + auth.User.String()) {
		return errRate
	}
	state, err := s.db.GetTOTP(ctx, auth.User)
	if err != nil {
		return err
	}
	if state.Pending == nil {
		return fail(http.StatusBadRequest, "no_pending", "Start the authenticator setup first.")
	}
	secret, err := s.secret.open(state.Pending, "totp")
	if err != nil {
		return err
	}
	step, ok := checkCode(secret, body.Code, totpPeriod, totpSkew, time.Now())
	if !ok {
		return fail(http.StatusUnauthorized, "bad_code", "That code is not right. Check your device's clock.")
	}
	codes, hashes, err := newRecoveryCodes(recoveryCodeCount)
	if err != nil {
		return err
	}
	if err := s.db.EnableTOTP(ctx, auth.User, step, hashes); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"recovery_codes": codes})
	return nil
}

func (s *Server) totpDisable(w http.ResponseWriter, r *http.Request, auth Auth) error {
	if s.cfg.Require2FA {
		return fail(http.StatusForbidden, "required", "This instance requires an authenticator.")
	}
	var body struct {
		AuthKey string `json:"auth_key"`
		Code    string `json:"code"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.reauthenticate(ctx, auth.User, body.AuthKey); err != nil {
		return err
	}
	if err := s.checkTOTP(ctx, auth.User, body.Code); err != nil {
		return err
	}
	if err := s.db.DisableTOTP(ctx, auth.User); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) regenerateRecoveryCodes(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var body struct {
		AuthKey string `json:"auth_key"`
		Code    string `json:"code"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.reauthenticate(ctx, auth.User, body.AuthKey); err != nil {
		return err
	}
	if err := s.checkTOTP(ctx, auth.User, body.Code); err != nil {
		return err
	}
	codes, hashes, err := newRecoveryCodes(recoveryCodeCount)
	if err != nil {
		return err
	}
	// Re-enabling with the same secret replaces the codes in one transaction.
	state, err := s.db.GetTOTP(ctx, auth.User)
	if err != nil {
		return err
	}
	if err := s.db.SetTOTPPending(ctx, auth.User, state.Secret); err != nil {
		return err
	}
	if err := s.db.EnableTOTP(ctx, auth.User, state.LastStep, hashes); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"recovery_codes": codes})
	return nil
}

// reauthenticate confirms the caller still knows the password.
func (s *Server) reauthenticate(ctx context.Context, user id.ID, authKey string) error {
	if !s.loginLimit.allow("reauth:" + user.String()) {
		return errRate
	}
	creds, err := s.db.CredentialsByID(ctx, user)
	if err != nil {
		return err
	}
	ok, err := s.checkAuthKey(ctx, authKey, creds.AuthHash)
	if err != nil {
		return err
	}
	if !ok {
		return fail(http.StatusForbidden, "bad_credentials", "Your password is wrong.")
	}
	return nil
}

func (s *Server) getBundle(w http.ResponseWriter, r *http.Request, auth Auth) error {
	bundle, err := s.db.GetKeyBundle(r.Context(), auth.User)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, bundle)
	return nil
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var body struct {
		AuthKey       string `json:"auth_key"`
		NewAuthKey    string `json:"new_auth_key"`
		KDFSalt       string `json:"kdf_salt"`
		KDFIterations int    `json:"kdf_iterations"`
		Bundle        string `json:"bundle"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.reauthenticate(ctx, auth.User, body.AuthKey); err != nil {
		return err
	}
	newKey, err := decodeAuthKey(body.NewAuthKey)
	if err != nil {
		return err
	}
	if salt, err := base64.StdEncoding.DecodeString(body.KDFSalt); err != nil || len(salt) < 16 {
		return fail(http.StatusBadRequest, "bad_kdf", "Malformed key derivation settings.")
	}
	if body.KDFIterations < minKDFIterations || body.KDFIterations > maxKDFIterations || body.Bundle == "" || len(body.Bundle) > maxBundleLen {
		return fail(http.StatusBadRequest, "bad_kdf", "Malformed key derivation settings.")
	}
	hash, err := s.hashPassword(ctx, base64.StdEncoding.EncodeToString(newKey))
	if err != nil {
		return err
	}
	if err := s.db.ChangePassword(ctx, auth.User, hash, body.KDFSalt, body.KDFIterations, body.Bundle); err != nil {
		return err
	}
	// Whoever knew the old password must lose access now.
	sessions, err := s.db.ListSessions(ctx, auth.User)
	if err != nil {
		return err
	}
	if err := s.db.DeleteOtherSessions(ctx, auth.User, auth.Session); err != nil {
		return err
	}
	for _, sn := range sessions {
		if sn.ID != auth.Session {
			s.hub.endAuth(sn.ID)
		}
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// resetKeys replaces a user's identity, for when the password and recovery key
// are both lost. Old messages become unreadable to them.
func (s *Server) resetKeys(w http.ResponseWriter, r *http.Request, auth Auth) error {
	var body struct {
		AuthKey        string `json:"auth_key"`
		SignKey        string `json:"sign_key"`
		DHKey          string `json:"dh_key"`
		Bundle         string `json:"bundle"`
		RecoveryBundle string `json:"recovery_bundle"`
	}
	if err := decode(r, w, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.reauthenticate(ctx, auth.User, body.AuthKey); err != nil {
		return err
	}
	if !validPublicKey(body.SignKey) || !validPublicKey(body.DHKey) || body.Bundle == "" || len(body.Bundle) > maxBundleLen ||
		len(body.RecoveryBundle) > maxBundleLen {
		return fail(http.StatusBadRequest, "bad_keys", "Malformed identity keys.")
	}
	if err := s.db.ResetKeys(ctx, auth.User, body.SignKey, body.DHKey, body.Bundle, body.RecoveryBundle); err != nil {
		return err
	}
	u, err := s.db.GetUser(ctx, auth.User)
	if err != nil {
		return err
	}
	contacts, err := s.db.ContactIDs(ctx, auth.User)
	if err != nil {
		return err
	}
	s.hub.send(contacts, "user.update", u)
	go s.requestKeysForUser(context.Background(), auth.User)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) startLogin(w http.ResponseWriter, r *http.Request, user id.ID, stage string) (string, error) {
	token, err := newToken()
	if err != nil {
		return "", err
	}
	label, _ := cleanLine("label", r.UserAgent(), 0, 1<<30)
	if utf8.RuneCountInString(label) > 120 {
		label = string([]rune(label)[:120])
	}
	if _, err := s.db.CreateSession(r.Context(), user, hashToken(token), stage, label); err != nil {
		return "", err
	}
	setSessionCookie(w, r, token, cookieLifetime)
	return token, nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, auth Auth) error {
	if err := s.db.DeleteSession(r.Context(), auth.User, auth.Session); err != nil {
		return err
	}
	s.hub.endAuth(auth.Session)
	setSessionCookie(w, r, "", -time.Hour)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
