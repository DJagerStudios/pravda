package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/sfu"
	"pravda/internal/store"
)

// VoiceState is one participant's place in a call, as everyone sees it.
type VoiceState struct {
	UserID     id.ID `json:"user_id"`
	ChannelID  id.ID `json:"channel_id"` // zero: the user left
	ServerID   id.ID `json:"server_id"`
	SelfMute   bool  `json:"self_mute"`
	SelfDeaf   bool  `json:"self_deaf"`
	ServerMute bool  `json:"server_mute"`
	ServerDeaf bool  `json:"server_deaf"`
	Video      bool  `json:"video"`
	Screen     bool  `json:"screen"`
}

type voiceConn struct {
	state   VoiceState
	session *Session
	peer    *sfu.Peer
	channel store.Channel
}

// Voice connects the gateway to the media server: it decides who may join,
// tracks everyone's state, and relays WebRTC negotiation.
type Voice struct {
	srv    *Server
	engine *sfu.Engine

	mu        sync.Mutex
	byUser    map[id.ID]*voiceConn
	byChannel map[id.ID]map[id.ID]*voiceConn
	watch     map[id.ID]*watchState
}

// watchState is a call's shared viewing: what is playing, whether it is
// paused, and where. The server relays it encrypted and cannot read it.
type watchState struct {
	ChannelID id.ID  `json:"channel_id"`
	Blob      string `json:"blob"`
	By        id.ID  `json:"by"`
	At        int64  `json:"at"`
}

func newVoice(s *Server, cfg sfu.Config) (*Voice, error) {
	v := &Voice{srv: s, byUser: map[id.ID]*voiceConn{}, byChannel: map[id.ID]map[id.ID]*voiceConn{}, watch: map[id.ID]*watchState{}}
	engine, err := sfu.New(cfg, v)
	if err != nil {
		return nil, err
	}
	v.engine = engine
	return v, nil
}

func (v *Voice) close() {
	v.engine.Close()
}

// SendSignal implements sfu.Handler.
func (v *Voice) SendSignal(_, peerID string, signal sfu.Signal) {
	user, err := id.Parse(peerID)
	if err != nil {
		return
	}
	v.mu.Lock()
	conn := v.byUser[user]
	v.mu.Unlock()
	if conn != nil {
		v.srv.hub.sendSession(conn.session, "voice.signal", signal)
	}
}

// Speaking implements sfu.Handler.
func (v *Voice) Speaking(roomID, peerID string, speaking bool) {
	channel, err1 := id.Parse(roomID)
	user, err2 := id.Parse(peerID)
	if err1 != nil || err2 != nil {
		return
	}
	v.mu.Lock()
	conn := v.byUser[user]
	v.mu.Unlock()
	if conn == nil || conn.channel.ID != channel {
		return
	}
	v.srv.toChannel(context.Background(), conn.channel, "voice.speaking", map[string]any{
		"channel_id": channel, "user_id": user, "speaking": speaking,
	})
}

// PeerFailed implements sfu.Handler.
func (v *Voice) PeerFailed(roomID, peerID string) {
	user, err := id.Parse(peerID)
	if err != nil {
		return
	}
	v.mu.Lock()
	conn := v.byUser[user]
	current := conn != nil && conn.channel.ID.String() == roomID
	v.mu.Unlock()
	if current {
		v.srv.hub.sendSession(conn.session, "voice.ended", map[string]any{"reason": "connection_lost"})
		v.leave(context.Background(), conn)
	}
}

// handleOp processes voice messages from the gateway.
func (v *Voice) handleOp(ctx context.Context, sn *Session, op string, raw json.RawMessage) error {
	switch op {
	case "voice_join":
		var d struct {
			ChannelID id.ID `json:"channel_id"`
			SelfMute  bool  `json:"self_mute"`
			SelfDeaf  bool  `json:"self_deaf"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			return errBadVoice
		}
		return v.join(ctx, sn, d.ChannelID, d.SelfMute, d.SelfDeaf)
	case "voice_leave":
		if conn := v.connFor(sn); conn != nil {
			v.leave(ctx, conn)
		}
		return nil
	case "voice_state":
		var d struct {
			SelfMute *bool `json:"self_mute"`
			SelfDeaf *bool `json:"self_deaf"`
			Video    *bool `json:"video"`
			Screen   *bool `json:"screen"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			return errBadVoice
		}
		conn := v.connFor(sn)
		if conn == nil {
			return nil
		}
		return v.update(ctx, conn, d.SelfMute, d.SelfDeaf, d.Video, d.Screen)
	case "voice_signal":
		var signal sfu.Signal
		if err := json.Unmarshal(raw, &signal); err != nil {
			return errBadVoice
		}
		conn := v.connFor(sn)
		if conn == nil {
			return nil // a late candidate after leaving is normal
		}
		if err := conn.peer.HandleSignal(signal); err != nil {
			slog.Debug("voice signal rejected", "user", sn.User, "err", err)
			return fail(http.StatusBadRequest, "bad_signal", "The call could not be negotiated.")
		}
		return nil
	case "watch_set", "watch_clear":
		var d struct {
			ChannelID id.ID  `json:"channel_id"`
			Blob      string `json:"blob"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			return errBadVoice
		}
		conn := v.connFor(sn)
		if conn == nil || conn.channel.ID != d.ChannelID {
			return fail(http.StatusForbidden, "not_in_call", "Join the call to share something.")
		}
		return v.setWatch(ctx, conn, op == "watch_clear", d.Blob)
	case "voice_watch":
		var d struct {
			UserID id.ID `json:"user_id"`
			On     bool  `json:"on"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			return errBadVoice
		}
		if conn := v.connFor(sn); conn != nil {
			conn.peer.Watch(d.UserID.String(), d.On)
		}
		return nil
	}
	return fail(http.StatusBadRequest, "unknown_op", "Unknown operation.")
}

var errBadVoice = fail(http.StatusBadRequest, "bad_voice", "Malformed voice message.")

// connFor returns the session's voice connection, if it owns one.
func (v *Voice) connFor(sn *Session) *voiceConn {
	v.mu.Lock()
	defer v.mu.Unlock()
	if conn := v.byUser[sn.User]; conn != nil && conn.session == sn {
		return conn
	}
	return nil
}

func (v *Voice) join(ctx context.Context, sn *Session, channelID id.ID, selfMute, selfDeaf bool) error {
	c, err := v.srv.db.GetChannel(ctx, channelID)
	if err != nil {
		return errNotFound
	}
	if c.Kind != store.KindVoice && !c.IsPrivate() {
		return fail(http.StatusBadRequest, "not_voice", "That is not a place for talking.")
	}
	perms, err := v.srv.channelPerms(ctx, sn.User, c)
	if err != nil {
		return err
	}
	if !perms.Has(perm.VoiceConnect) {
		return errForbidden
	}

	state := VoiceState{UserID: sn.User, ChannelID: c.ID, ServerID: c.ServerID, SelfMute: selfMute, SelfDeaf: selfDeaf}
	if !c.IsPrivate() {
		member, err := v.srv.db.GetMember(ctx, c.ServerID, sn.User)
		if err != nil {
			return err
		}
		state.ServerMute = member.ServerMute
		state.ServerDeaf = member.ServerDeaf
	}
	canSpeak := perms.Has(perm.VoiceSpeak)

	// One call at a time: joining anywhere ends the previous call, even on
	// another device.
	v.mu.Lock()
	previous := v.byUser[sn.User]
	full := c.UserLimit > 0 && len(v.byChannel[c.ID]) >= c.UserLimit && !perms.Has(perm.VoiceMoveOthers)
	v.mu.Unlock()
	if full {
		return fail(http.StatusForbidden, "channel_full", "This voice channel is full.")
	}
	if previous != nil {
		if previous.session != sn {
			v.srv.hub.sendSession(previous.session, "voice.ended", map[string]any{"reason": "moved_elsewhere"})
		}
		v.leave(ctx, previous)
	}

	peer, err := v.engine.Join(c.ID.String(), sn.User.String())
	if err != nil {
		return err
	}
	conn := &voiceConn{state: state, session: sn, peer: peer, channel: c}
	peer.SetSilenced(state.ServerMute || !canSpeak)
	peer.SetDeaf(state.SelfDeaf || state.ServerDeaf)
	peer.SetPublishing(sfu.SourceMic, true)

	v.mu.Lock()
	first := len(v.byChannel[c.ID]) == 0
	v.byUser[sn.User] = conn
	room := v.byChannel[c.ID]
	if room == nil {
		room = map[id.ID]*voiceConn{}
		v.byChannel[c.ID] = room
	}
	room[sn.User] = conn
	v.mu.Unlock()

	v.mu.Lock()
	watch := v.watch[c.ID]
	v.mu.Unlock()
	v.srv.hub.sendSession(sn, "voice.ready", map[string]any{
		"channel_id": c.ID, "server_id": c.ServerID, "can_speak": canSpeak && !state.ServerMute, "watch": watch,
	})
	v.broadcast(ctx, conn)
	if first && c.IsPrivate() {
		v.ring(ctx, c, sn.User)
	}
	return nil
}

// ring invites the other participants of a private call.
func (v *Voice) ring(ctx context.Context, c store.Channel, from id.ID) {
	participants, err := v.srv.db.DMParticipants(ctx, c.ID)
	if err != nil {
		return
	}
	var others []id.ID
	for _, p := range participants {
		if p != from {
			others = append(others, p)
		}
	}
	v.srv.hub.send(others, "call.ring", map[string]any{"channel_id": c.ID, "from": from})
}

func (v *Voice) broadcast(ctx context.Context, conn *voiceConn) {
	v.mu.Lock()
	state := conn.state
	v.mu.Unlock()
	v.srv.toChannel(ctx, conn.channel, "voice.state", state)
}

func (v *Voice) leave(ctx context.Context, conn *voiceConn) {
	v.mu.Lock()
	user := conn.state.UserID
	if v.byUser[user] != conn {
		v.mu.Unlock()
		return
	}
	delete(v.byUser, user)
	room := v.byChannel[conn.channel.ID]
	delete(room, user)
	empty := len(room) == 0
	if empty {
		delete(v.byChannel, conn.channel.ID)
		delete(v.watch, conn.channel.ID)
	}
	left := conn.state
	left.ChannelID = 0
	left.Video, left.Screen = false, false
	v.mu.Unlock()

	conn.peer.Leave()
	// Include the old channel so clients can remove them from the right list.
	v.srv.toChannel(ctx, conn.channel, "voice.state", struct {
		VoiceState
		LeftChannelID id.ID `json:"left_channel_id"`
	}{left, conn.channel.ID})
	if empty && conn.channel.IsPrivate() {
		v.srv.toChannel(ctx, conn.channel, "call.end", map[string]any{"channel_id": conn.channel.ID})
	}
}

func (v *Voice) update(ctx context.Context, conn *voiceConn, selfMute, selfDeaf, video, screen *bool) error {
	perms, err := v.srv.channelPerms(ctx, conn.state.UserID, conn.channel)
	if err != nil {
		return err
	}
	if video != nil && *video && !perms.Has(perm.VoiceVideo) {
		return errForbidden
	}
	if screen != nil && *screen && !perms.Has(perm.VoiceStream) {
		return errForbidden
	}
	v.mu.Lock()
	st := &conn.state
	if selfMute != nil {
		st.SelfMute = *selfMute
	}
	if selfDeaf != nil {
		st.SelfDeaf = *selfDeaf
	}
	if video != nil {
		st.Video = *video
	}
	if screen != nil {
		st.Screen = *screen
	}
	deaf := st.SelfDeaf || st.ServerDeaf
	showVideo, showScreen := st.Video, st.Screen
	v.mu.Unlock()

	conn.peer.SetDeaf(deaf)
	conn.peer.SetPublishing(sfu.SourceCamera, showVideo)
	conn.peer.SetPublishing(sfu.SourceScreen, showScreen)
	conn.peer.SetPublishing(sfu.SourceScreenAudio, showScreen)
	v.broadcast(ctx, conn)
	return nil
}

// setWatch replaces or clears a call's shared viewing.
func (v *Voice) setWatch(ctx context.Context, conn *voiceConn, clear bool, blob string) error {
	perms, err := v.srv.channelPerms(ctx, conn.state.UserID, conn.channel)
	if err != nil {
		return err
	}
	if !perms.Has(perm.VoiceStream) {
		return errForbidden
	}
	state := &watchState{ChannelID: conn.channel.ID, By: conn.state.UserID, At: time.Now().UnixMilli()}
	if !clear {
		env, err := parseEnvelope("watch", blob, maxWatchLen)
		if err != nil {
			return err
		}
		if err := v.srv.requireFreshKey(ctx, conn.channel, env.E); err != nil {
			return err
		}
		state.Blob = blob
	}
	v.mu.Lock()
	if clear {
		delete(v.watch, conn.channel.ID)
	} else {
		v.watch[conn.channel.ID] = state
	}
	v.mu.Unlock()
	v.srv.toChannel(ctx, conn.channel, "watch.state", state)
	return nil
}

// rotateActiveCalls asks the people in a server's live calls to replace the
// call key when someone who held it lost access, so they cannot decrypt the
// rest of the call even with a recording of its packets.
func (v *Voice) rotateActiveCalls(ctx context.Context, server id.ID) {
	v.mu.Lock()
	byChannel := map[id.ID][]*voiceConn{}
	for _, conn := range v.byUser {
		if conn.state.ServerID == server {
			byChannel[conn.channel.ID] = append(byChannel[conn.channel.ID], conn)
		}
	}
	v.mu.Unlock()
	for channelID, conns := range byChannel {
		c, err := v.srv.db.GetChannel(ctx, channelID)
		if err != nil {
			continue
		}
		viewers, err := v.srv.channelAudience(ctx, c)
		if err != nil {
			continue
		}
		stale, err := v.srv.staleHolders(ctx, c, viewers)
		if err != nil || len(stale) == 0 {
			continue
		}
		for _, conn := range conns {
			v.srv.hub.sendSession(conn.session, "keys.rotate", map[string]any{"channel_id": channelID})
		}
	}
}

// moderate applies a moderator's mute or deafen to someone in a call.
func (v *Voice) moderate(ctx context.Context, server, user id.ID, mute, deaf *bool) {
	v.mu.Lock()
	conn := v.byUser[user]
	if conn == nil || conn.state.ServerID != server {
		v.mu.Unlock()
		return
	}
	if mute != nil {
		conn.state.ServerMute = *mute
	}
	if deaf != nil {
		conn.state.ServerDeaf = *deaf
	}
	silenced := conn.state.ServerMute
	deafened := conn.state.SelfDeaf || conn.state.ServerDeaf
	v.mu.Unlock()
	conn.peer.SetSilenced(silenced)
	conn.peer.SetDeaf(deafened)
	v.broadcast(ctx, conn)
}

// recheck re-applies permissions to a server's calls after a change, so that
// losing a right takes effect immediately rather than at the next join.
func (v *Voice) recheck(ctx context.Context, server id.ID) {
	v.mu.Lock()
	var conns []*voiceConn
	for _, conn := range v.byUser {
		if conn.state.ServerID == server {
			conns = append(conns, conn)
		}
	}
	v.mu.Unlock()
	for _, conn := range conns {
		perms, err := v.srv.channelPerms(ctx, conn.state.UserID, conn.channel)
		if err != nil {
			slog.Warn("rechecking voice permissions", "err", err)
			continue
		}
		if !perms.Has(perm.VoiceConnect) {
			v.srv.hub.sendSession(conn.session, "voice.ended", map[string]any{"reason": "removed"})
			v.leave(ctx, conn)
			continue
		}
		v.mu.Lock()
		video := conn.state.Video && perms.Has(perm.VoiceVideo)
		screen := conn.state.Screen && perms.Has(perm.VoiceStream)
		changed := video != conn.state.Video || screen != conn.state.Screen
		conn.state.Video, conn.state.Screen = video, screen
		silenced := conn.state.ServerMute || !perms.Has(perm.VoiceSpeak)
		v.mu.Unlock()
		conn.peer.SetSilenced(silenced)
		conn.peer.SetPublishing(sfu.SourceCamera, video)
		conn.peer.SetPublishing(sfu.SourceScreen, screen)
		conn.peer.SetPublishing(sfu.SourceScreenAudio, screen)
		if changed {
			v.broadcast(ctx, conn)
		}
	}
}

// removeFromServer ends a user's call when they leave or are removed.
func (v *Voice) removeFromServer(ctx context.Context, server, user id.ID) {
	v.mu.Lock()
	conn := v.byUser[user]
	v.mu.Unlock()
	if conn != nil && conn.state.ServerID == server {
		v.srv.hub.sendSession(conn.session, "voice.ended", map[string]any{"reason": "removed"})
		v.leave(ctx, conn)
	}
}

// disconnect removes a user from a call on a moderator's order.
func (v *Voice) disconnect(ctx context.Context, server, user id.ID) bool {
	v.mu.Lock()
	conn := v.byUser[user]
	v.mu.Unlock()
	if conn == nil || conn.state.ServerID != server {
		return false
	}
	v.srv.hub.sendSession(conn.session, "voice.ended", map[string]any{"reason": "disconnected"})
	v.leave(ctx, conn)
	return true
}

// clearChannel ends every call in a channel that is being deleted.
func (v *Voice) clearChannel(ctx context.Context, channel id.ID) {
	v.mu.Lock()
	conns := make([]*voiceConn, 0, len(v.byChannel[channel]))
	for _, conn := range v.byChannel[channel] {
		conns = append(conns, conn)
	}
	v.mu.Unlock()
	for _, conn := range conns {
		v.srv.hub.sendSession(conn.session, "voice.ended", map[string]any{"reason": "channel_deleted"})
		v.leave(ctx, conn)
	}
}

// sessionEnded cleans up after a client is gone for good.
func (v *Voice) sessionEnded(sn *Session) {
	if conn := v.connFor(sn); conn != nil {
		v.leave(context.Background(), conn)
	}
}

// statesIn lists the voice states in a server's visible channels.
func (v *Voice) statesIn(server id.ID, visible map[id.ID]bool) []VoiceState {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := []VoiceState{}
	for _, conn := range v.byUser {
		if conn.state.ServerID == server && visible[conn.state.ChannelID] {
			out = append(out, conn.state)
		}
	}
	return out
}

// dmStates lists the voice states in the given private channels.
func (v *Voice) dmStates(channels []store.Channel) []VoiceState {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := []VoiceState{}
	for _, c := range channels {
		for _, conn := range v.byChannel[c.ID] {
			out = append(out, conn.state)
		}
	}
	return out
}
