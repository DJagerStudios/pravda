package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"pravda/internal/id"
)

const (
	heartbeatInterval = 20 * time.Second
	heartbeatTimeout  = 50 * time.Second
	identifyTimeout   = 15 * time.Second
	writeTimeout      = 10 * time.Second
	// sessionLinger is how long a dropped session waits to be resumed before
	// its owner counts as gone. Short network blips stay invisible.
	sessionLinger = 60 * time.Second
	ringCapacity  = 4096 // events kept for replay
	maxQueue      = 8192 // undelivered frames before a client is cut off
	maxFrameBytes = 1 << 20

	closeAuthFailed = 4001
	closeBadSession = 4002
	closeRateLimit  = 4008
	closeProtocol   = 4010
)

// frameIn is what clients send over the gateway.
type frameIn struct {
	Op string          `json:"op"`
	D  json.RawMessage `json:"d"`
}

// Session is a client's logical connection. It outlives the WebSocket, so a
// brief disconnect loses nothing: events keep accumulating in the ring and
// are replayed on resume.
type Session struct {
	ID     string
	User   id.ID
	AuthID id.ID

	hub *Hub

	mu     sync.Mutex
	seq    int64
	ring   []ringEntry
	head   int // index of the oldest entry once the ring has wrapped
	conn   *gatewayConn
	linger *time.Timer
	ended  bool
}

type ringEntry struct {
	seq   int64
	frame []byte
}

// gatewayConn is one live WebSocket attached to a session.
type gatewayConn struct {
	ws     *websocket.Conn
	cancel context.CancelFunc
	wake   chan struct{}

	// Guarded by the session lock.
	queue [][]byte
}

// send appends a frame for the writer. Callers hold the session lock.
func (c *gatewayConn) send(frame []byte) bool {
	if len(c.queue) >= maxQueue {
		return false
	}
	c.queue = append(c.queue, frame)
	select {
	case c.wake <- struct{}{}:
	default:
	}
	return true
}

func (sn *Session) addToRing(e ringEntry) {
	if len(sn.ring) < ringCapacity {
		sn.ring = append(sn.ring, e)
		return
	}
	sn.ring[sn.head] = e
	sn.head = (sn.head + 1) % ringCapacity
}

// dispatch sequences a prepared event body and delivers or stores it.
func (sn *Session) dispatch(body []byte) {
	sn.mu.Lock()
	defer sn.mu.Unlock()
	if sn.ended {
		return
	}
	sn.seq++
	frame := make([]byte, 0, len(body)+32)
	frame = append(frame, `{"op":"event","s":`...)
	frame = strconv.AppendInt(frame, sn.seq, 10)
	frame = append(frame, ',')
	frame = append(frame, body...)
	sn.addToRing(ringEntry{sn.seq, frame})
	if sn.conn != nil && !sn.conn.send(frame) {
		// Too far behind to catch up in order: cut the connection. The client
		// can resume from the ring or start afresh.
		sn.conn.cancel()
		sn.conn = nil
	}
}

// replayFrom returns the frames after seq, or false if some were lost.
func (sn *Session) replayFrom(seq int64) ([][]byte, bool) {
	if seq == sn.seq {
		return nil, true
	}
	if seq > sn.seq || len(sn.ring) == 0 {
		return nil, false
	}
	oldest := sn.ring[sn.head].seq
	if seq+1 < oldest {
		return nil, false
	}
	out := make([][]byte, 0, sn.seq-seq)
	for i := range sn.ring {
		e := sn.ring[(sn.head+i)%len(sn.ring)]
		if e.seq > seq {
			out = append(out, e.frame)
		}
	}
	return out, true
}

// Hub tracks sessions and routes events to them.
type Hub struct {
	srv *Server

	mu       sync.RWMutex
	sessions map[string]*Session
	byUser   map[id.ID]map[*Session]struct{}
	status   map[id.ID]string // users' chosen status while online
}

func newHub(s *Server) *Hub {
	return &Hub{srv: s, sessions: map[string]*Session{}, byUser: map[id.ID]map[*Session]struct{}{}, status: map[id.ID]string{}}
}

// eventBody renders the part of a frame shared by all recipients.
func eventBody(event string, data any) ([]byte, error) {
	d, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	name, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	body := make([]byte, 0, len(d)+len(name)+16)
	body = append(body, `"t":`...)
	body = append(body, name...)
	body = append(body, `,"d":`...)
	body = append(body, d...)
	body = append(body, '}')
	return body, nil
}

// send delivers an event to every session of the given users.
func (h *Hub) send(users []id.ID, event string, data any) {
	body, err := eventBody(event, data)
	if err != nil {
		slog.Error("encoding event", "event", event, "err", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, user := range users {
		for sn := range h.byUser[user] {
			sn.dispatch(body)
		}
	}
}

// sendSession delivers an event to one session only.
func (h *Hub) sendSession(sn *Session, event string, data any) {
	body, err := eventBody(event, data)
	if err != nil {
		slog.Error("encoding event", "event", event, "err", err)
		return
	}
	sn.dispatch(body)
}

func (h *Hub) add(sn *Session, status string) (firstOnline bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sessions[sn.ID] = sn
	set := h.byUser[sn.User]
	if set == nil {
		set = map[*Session]struct{}{}
		h.byUser[sn.User] = set
		firstOnline = true
	}
	set[sn] = struct{}{}
	h.status[sn.User] = status
	return firstOnline
}

func (h *Hub) remove(sn *Session) (lastOffline bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.sessions, sn.ID)
	set := h.byUser[sn.User]
	if set == nil {
		return false
	}
	delete(set, sn)
	if len(set) == 0 {
		delete(h.byUser, sn.User)
		delete(h.status, sn.User)
		return true
	}
	return false
}

func (h *Hub) get(sessionID string) *Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.sessions[sessionID]
}

// presence returns what others should see for a user.
func (h *Hub) presence(user id.ID) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	status, online := h.status[user]
	if !online || status == "invisible" {
		return "offline"
	}
	return status
}

// presences returns the visible status of everyone online among users.
func (h *Hub) presences(users []id.ID) map[id.ID]string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[id.ID]string)
	for _, u := range users {
		if status, online := h.status[u]; online && status != "invisible" {
			out[u] = status
		}
	}
	return out
}

// setStatus records a status change for an online user.
func (h *Hub) setStatus(user id.ID, status string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, online := h.status[user]; online {
		h.status[user] = status
	}
}

// userSessions lists a user's sessions.
func (h *Hub) userSessions(user id.ID) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*Session, 0, len(h.byUser[user]))
	for sn := range h.byUser[user] {
		out = append(out, sn)
	}
	return out
}

// endAuth terminates every gateway session opened with a given login.
func (h *Hub) endAuth(authID id.ID) {
	h.mu.RLock()
	var targets []*Session
	for _, sn := range h.sessions {
		if sn.AuthID == authID {
			targets = append(targets, sn)
		}
	}
	h.mu.RUnlock()
	for _, sn := range targets {
		h.srv.endSession(sn, closeAuthFailed, "signed out")
	}
}

func (h *Hub) closeAll() {
	h.mu.RLock()
	targets := make([]*Session, 0, len(h.sessions))
	for _, sn := range h.sessions {
		targets = append(targets, sn)
	}
	h.mu.RUnlock()
	for _, sn := range targets {
		sn.mu.Lock()
		if sn.conn != nil {
			sn.conn.ws.Close(websocket.StatusGoingAway, "server shutting down")
			sn.conn.cancel()
		}
		if sn.linger != nil {
			sn.linger.Stop()
		}
		sn.mu.Unlock()
	}
}

// endSession tears a session down for good.
func (s *Server) endSession(sn *Session, code websocket.StatusCode, reason string) {
	sn.mu.Lock()
	if sn.ended {
		sn.mu.Unlock()
		return
	}
	sn.ended = true
	if sn.linger != nil {
		sn.linger.Stop()
	}
	conn := sn.conn
	sn.conn = nil
	sn.mu.Unlock()
	if conn != nil {
		conn.ws.Close(code, reason)
		conn.cancel()
	}
	s.voice.sessionEnded(sn)
	if s.hub.remove(sn) {
		s.broadcastPresence(context.Background(), sn.User, "offline")
	}
}

// broadcastPresence tells a user's contacts their new status.
func (s *Server) broadcastPresence(ctx context.Context, user id.ID, status string) {
	contacts, err := s.db.ContactIDs(ctx, user)
	if err != nil {
		slog.Warn("listing contacts", "err", err)
		return
	}
	s.hub.send(contacts, "presence.update", map[string]any{"user_id": user, "status": status})
}

// handleGateway upgrades to a WebSocket and runs the session protocol.
func (s *Server) handleGateway(w http.ResponseWriter, r *http.Request) {
	// Any origin may connect, but only same-site pages may authenticate with
	// the session cookie. Others (the desktop app) must present a token in
	// identify, which no third-party page can obtain.
	foreign := r.Header.Get("Origin") != "" && !s.sameSite(r.Header.Get("Origin"), r.Host)
	opts := &websocket.AcceptOptions{CompressionMode: websocket.CompressionContextTakeover, InsecureSkipVerify: true}
	ws, err := websocket.Accept(w, r, opts)
	if err != nil {
		return // Accept has already written the response
	}
	ws.SetReadLimit(maxFrameBytes)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &gatewayConn{ws: ws, cancel: cancel, wake: make(chan struct{}, 1)}

	hello := map[string]any{"heartbeat_ms": heartbeatInterval.Milliseconds(), "server_time": time.Now().UnixMilli()}
	if err := writeControl(ctx, ws, "hello", hello); err != nil {
		ws.CloseNow()
		return
	}

	sn, ok := s.startSession(ctx, conn, r, foreign)
	if !ok {
		ws.CloseNow()
		return
	}

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		s.writeLoop(ctx, sn, conn)
	}()
	s.readLoop(ctx, sn, conn)
	cancel()
	<-writerDone
	ws.CloseNow()

	sn.mu.Lock()
	defer sn.mu.Unlock()
	if sn.conn == conn && !sn.ended {
		sn.conn = nil
		sn.linger = time.AfterFunc(sessionLinger, func() { s.endSession(sn, websocket.StatusNormalClosure, "") })
	}
}

func writeControl(ctx context.Context, ws *websocket.Conn, op string, data any) error {
	frame, err := json.Marshal(map[string]any{"op": op, "d": data})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return ws.Write(ctx, websocket.MessageText, frame)
}

// startSession waits for identify or resume.
func (s *Server) startSession(ctx context.Context, conn *gatewayConn, r *http.Request, foreign bool) (*Session, bool) {
	readCtx, cancel := context.WithTimeout(ctx, identifyTimeout)
	defer cancel()
	_, raw, err := conn.ws.Read(readCtx)
	if err != nil {
		return nil, false
	}
	var msg frameIn
	if json.Unmarshal(raw, &msg) != nil {
		conn.ws.Close(closeProtocol, "invalid message")
		return nil, false
	}
	var body struct {
		Token     string `json:"token"`
		SessionID string `json:"session_id"`
		Seq       int64  `json:"seq"`
	}
	if len(msg.D) > 0 && json.Unmarshal(msg.D, &body) != nil {
		conn.ws.Close(closeProtocol, "invalid message")
		return nil, false
	}

	if foreign && body.Token == "" {
		conn.ws.Close(closeAuthFailed, "cross-origin connections must present a token")
		return nil, false
	}
	auth, err := s.gatewayAuth(ctx, r, body.Token)
	if err != nil || auth.Stage != stageFull {
		conn.ws.Close(closeAuthFailed, "authentication failed")
		return nil, false
	}

	switch msg.Op {
	case "identify":
		return s.identify(ctx, conn, auth)
	case "resume":
		return s.resume(ctx, conn, auth, body.SessionID, body.Seq)
	}
	conn.ws.Close(closeProtocol, "expected identify or resume")
	return nil, false
}

func (s *Server) gatewayAuth(ctx context.Context, r *http.Request, token string) (Auth, error) {
	if token != "" {
		return s.authenticateToken(ctx, token)
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return Auth{}, errAuth
	}
	return s.authenticateToken(ctx, c.Value)
}

func (s *Server) identify(ctx context.Context, conn *gatewayConn, auth Auth) (*Session, bool) {
	account, err := s.db.GetAccount(ctx, auth.User)
	if err != nil {
		conn.ws.Close(closeAuthFailed, "authentication failed")
		return nil, false
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, false
	}
	sn := &Session{ID: hex.EncodeToString(idBytes), User: auth.User, AuthID: auth.Session, hub: s.hub}

	// Register before building ready so nothing can fall between the
	// snapshot and the live stream. Events that overlap are harmless: clients
	// apply them idempotently.
	sn.mu.Lock()
	sn.conn = conn
	sn.mu.Unlock()
	if s.hub.add(sn, account.Status) && account.Status != "invisible" {
		s.broadcastPresence(ctx, auth.User, account.Status)
	}

	ready, err := s.buildReady(ctx, sn, account)
	if err != nil {
		slog.Error("building ready", "err", err)
		s.endSession(sn, websocket.StatusInternalError, "could not load your state")
		return nil, false
	}
	if err := writeControl(ctx, conn.ws, "ready", ready); err != nil {
		sn.mu.Lock()
		if sn.conn == conn {
			sn.conn = nil
			sn.linger = time.AfterFunc(sessionLinger, func() { s.endSession(sn, websocket.StatusNormalClosure, "") })
		}
		sn.mu.Unlock()
		return nil, false
	}
	return sn, true
}

func (s *Server) resume(ctx context.Context, conn *gatewayConn, auth Auth, sessionID string, seq int64) (*Session, bool) {
	sn := s.hub.get(sessionID)
	if sn == nil || sn.User != auth.User {
		_ = writeControl(ctx, conn.ws, "invalid_session", nil)
		conn.ws.Close(closeBadSession, "session cannot be resumed")
		return nil, false
	}
	sn.mu.Lock()
	defer sn.mu.Unlock()
	if sn.ended {
		_ = writeControl(ctx, conn.ws, "invalid_session", nil)
		conn.ws.Close(closeBadSession, "session cannot be resumed")
		return nil, false
	}
	frames, ok := sn.replayFrom(seq)
	if !ok {
		_ = writeControl(ctx, conn.ws, "invalid_session", nil)
		conn.ws.Close(closeBadSession, "too many events were missed")
		return nil, false
	}
	if sn.linger != nil {
		sn.linger.Stop()
		sn.linger = nil
	}
	if old := sn.conn; old != nil {
		old.cancel()
	}
	sn.conn = conn
	resumed, err := json.Marshal(map[string]any{"op": "resumed", "d": map[string]any{"replayed": len(frames)}})
	if err != nil {
		return nil, false
	}
	conn.send(resumed)
	for _, f := range frames {
		conn.send(f)
	}
	return sn, true
}

func (s *Server) writeLoop(ctx context.Context, sn *Session, conn *gatewayConn) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.wake:
		}
		for {
			sn.mu.Lock()
			batch := conn.queue
			conn.queue = nil
			sn.mu.Unlock()
			if len(batch) == 0 {
				break
			}
			for _, frame := range batch {
				writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
				err := conn.ws.Write(writeCtx, websocket.MessageText, frame)
				cancel()
				if err != nil {
					conn.cancel()
					return
				}
			}
		}
	}
}

func (s *Server) readLoop(ctx context.Context, sn *Session, conn *gatewayConn) {
	limit := rate.NewLimiter(60, 120)
	for {
		readCtx, cancel := context.WithTimeout(ctx, heartbeatTimeout)
		_, raw, err := conn.ws.Read(readCtx)
		cancel()
		if err != nil {
			return
		}
		if !limit.Allow() {
			conn.ws.Close(closeRateLimit, "too many messages")
			return
		}
		var msg frameIn
		if json.Unmarshal(raw, &msg) != nil {
			conn.ws.Close(closeProtocol, "invalid message")
			return
		}
		switch msg.Op {
		case "ping":
			frame, _ := json.Marshal(map[string]any{"op": "pong", "d": map[string]any{"server_time": time.Now().UnixMilli()}})
			sn.mu.Lock()
			if sn.conn == conn {
				conn.send(frame)
			}
			sn.mu.Unlock()
		case "bye":
			// A deliberate goodbye skips the linger period.
			s.endSession(sn, websocket.StatusNormalClosure, "")
			return
		default:
			if err := s.voice.handleOp(ctx, sn, msg.Op, msg.D); err != nil {
				s.reportOpError(sn, msg.Op, err)
			}
		}
	}
}

func (s *Server) reportOpError(sn *Session, op string, err error) {
	var ae *apiError
	if !errors.As(err, &ae) {
		slog.Warn("gateway operation failed", "op", op, "err", err)
		ae = fail(http.StatusInternalServerError, "internal", "Something went wrong.")
	}
	s.hub.sendSession(sn, "op.error", map[string]any{"op": op, "code": ae.Code, "message": ae.Message})
}
