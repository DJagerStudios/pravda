package sfu

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const gatherTimeout = 3 * time.Second

// Peer is one participant in a room.
type Peer struct {
	id   string
	room *Room
	pub  *webrtc.PeerConnection
	sub  *webrtc.PeerConnection

	// Guarded by room.mu.
	mids       map[string]Source
	tracks     map[Source]*pubTrack
	publishing map[Source]bool
	subs       map[*pubTrack]*subTrack
	watching   map[string]bool // peers whose screen this participant watches
	deaf       bool
	silenced   bool // moderator mute
	speaking   bool
	left       bool

	// Negotiation of the sub connection. Exactly one offer is outstanding at
	// a time; changes made meanwhile set dirty and trigger a follow-up.
	negMu    sync.Mutex
	offering bool
	dirty    bool
	closed   bool

	failOnce sync.Once
}

func newPeer(e *Engine, r *Room, id string) (*Peer, error) {
	pub, err := e.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	sub, err := e.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		pub.Close()
		return nil, err
	}
	p := &Peer{
		id: id, room: r, pub: pub, sub: sub,
		mids:       map[string]Source{},
		tracks:     map[Source]*pubTrack{},
		publishing: map[Source]bool{},
		subs:       map[*pubTrack]*subTrack{},
		watching:   map[string]bool{},
	}
	pub.OnTrack(p.onTrack)
	// A connection also closes by itself when the client hangs up, because
	// DTLS close-notify shuts the server side down too. Either way the
	// participant is gone unless Leave got here first.
	failed := func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			p.failOnce.Do(func() { go e.handler.PeerFailed(r.id, id) })
		}
	}
	pub.OnConnectionStateChange(failed)
	sub.OnConnectionStateChange(failed)
	return p, nil
}

// ID returns the participant's identifier.
func (p *Peer) ID() string { return p.id }

func (p *Peer) onTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	mid := ""
	for _, t := range p.pub.GetTransceivers() {
		if t.Receiver() == receiver {
			mid = t.Mid()
			break
		}
	}
	r := p.room
	r.mu.Lock()
	source, known := p.mids[mid]
	if !known || p.left {
		r.mu.Unlock()
		slog.Debug("ignoring undeclared track", "peer", p.id, "mid", mid)
		return
	}
	if old := p.tracks[source]; old != nil {
		old.closed.Store(true)
	}
	t := &pubTrack{peer: p, source: source, remote: remote, kind: remote.Kind(), active: p.allowed(source)}
	if source == SourceMic {
		t.levelExt = audioLevelExtension(receiver)
	}
	p.tracks[source] = t
	r.reconcile()
	r.mu.Unlock()

	t.run()

	r.mu.Lock()
	t.closed.Store(true)
	if p.tracks[source] == t {
		delete(p.tracks, source)
	}
	r.reconcile()
	r.mu.Unlock()
}

// allowed reports whether a source should currently be forwarded. Callers hold
// room.mu.
func (p *Peer) allowed(source Source) bool {
	if source == SourceMic || source == SourceScreenAudio {
		if p.silenced {
			return false
		}
	}
	return p.publishing[source]
}

func (p *Peer) addSub(t *pubTrack) bool {
	stream := p.streamID(t)
	local, err := webrtc.NewTrackLocalStaticRTP(t.remote.Codec().RTPCodecCapability, stream, stream)
	if err != nil {
		slog.Warn("creating forwarded track", "err", err)
		return false
	}
	sender, err := p.sub.AddTrack(local)
	if err != nil {
		slog.Warn("adding forwarded track", "err", err)
		return false
	}
	s := &subTrack{track: t, local: local, sender: sender}
	p.subs[t] = s
	t.setSubs(func(list []*subTrack) []*subTrack { return append(list, s) })
	go s.readRTCP()
	return true
}

func (p *Peer) streamID(t *pubTrack) string {
	return t.peer.id + ":" + string(t.source)
}

func (p *Peer) removeSub(t *pubTrack, s *subTrack) {
	delete(p.subs, t)
	t.setSubs(func(list []*subTrack) []*subTrack {
		for i, v := range list {
			if v == s {
				return append(list[:i], list[i+1:]...)
			}
		}
		return list
	})
	if err := p.sub.RemoveTrack(s.sender); err != nil && !errors.Is(err, webrtc.ErrConnectionClosed) {
		slog.Debug("removing forwarded track", "err", err)
	}
}

// negotiate sends the client a fresh offer describing its forwarded tracks.
func (p *Peer) negotiate() {
	p.negMu.Lock()
	defer p.negMu.Unlock()
	if p.closed {
		return
	}
	if p.offering {
		p.dirty = true
		return
	}
	if len(p.sub.GetTransceivers()) == 0 {
		return // nothing to receive yet; an empty offer would fail
	}
	if p.sub.ConnectionState() == webrtc.PeerConnectionStateClosed {
		return // the client hung up; PeerFailed is on its way
	}
	offer, err := p.sub.CreateOffer(nil)
	if err != nil {
		slog.Warn("creating sub offer", "peer", p.id, "err", err)
		return
	}
	gathered := webrtc.GatheringCompletePromise(p.sub)
	if err := p.sub.SetLocalDescription(offer); err != nil {
		slog.Warn("setting sub offer", "peer", p.id, "err", err)
		return
	}
	waitGathered(gathered)
	p.offering = true
	p.room.engine.handler.SendSignal(p.room.id, p.id, Signal{PC: "sub", Type: "offer", SDP: p.sub.LocalDescription().SDP})
}

func waitGathered(done <-chan struct{}) {
	select {
	case <-done:
	case <-time.After(gatherTimeout):
	}
}

// HandleSignal applies a negotiation message from the client.
func (p *Peer) HandleSignal(s Signal) error {
	switch {
	case s.PC == "pub" && s.Type == "offer":
		return p.handlePubOffer(s)
	case s.PC == "sub" && s.Type == "answer":
		return p.handleSubAnswer(s)
	case s.Type == "candidate" && s.Candidate != nil:
		pc := p.pub
		if s.PC == "sub" {
			pc = p.sub
		}
		// Candidates are a nicety here: the server is directly reachable, so
		// clients are discovered from their first packets anyway. Browsers
		// also hide local addresses behind mDNS names this server cannot
		// resolve, so a bad candidate is no reason to abandon the call.
		if err := pc.AddICECandidate(*s.Candidate); err != nil {
			slog.Debug("ignoring ICE candidate", "peer", p.id, "err", err)
		}
		return nil
	}
	return fmt.Errorf("unexpected signal %s/%s", s.PC, s.Type)
}

func (p *Peer) handlePubOffer(s Signal) error {
	r := p.room
	r.mu.Lock()
	for mid, source := range s.Mids {
		switch source {
		case SourceMic, SourceCamera, SourceScreen, SourceScreenAudio:
			p.mids[mid] = source
		default:
			r.mu.Unlock()
			return fmt.Errorf("unknown source %q", source)
		}
	}
	r.mu.Unlock()
	if err := p.pub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: s.SDP}); err != nil {
		return err
	}
	answer, err := p.pub.CreateAnswer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(p.pub)
	if err := p.pub.SetLocalDescription(answer); err != nil {
		return err
	}
	waitGathered(gathered)
	r.engine.handler.SendSignal(r.id, p.id, Signal{PC: "pub", Type: "answer", SDP: p.pub.LocalDescription().SDP})
	return nil
}

func (p *Peer) handleSubAnswer(s Signal) error {
	p.negMu.Lock()
	if !p.offering {
		p.negMu.Unlock()
		return errors.New("answer without an outstanding offer")
	}
	err := p.sub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: s.SDP})
	p.offering = false
	again := p.dirty
	p.dirty = false
	p.negMu.Unlock()
	if err != nil {
		return err
	}
	if again {
		go p.negotiate()
	}
	// Viewers cannot decode video until the next keyframe.
	r := p.room
	r.mu.Lock()
	for t := range p.subs {
		t.requestKeyframe()
	}
	r.mu.Unlock()
	return nil
}

// SetPublishing declares whether a source is on. Media from a source that is
// off is dropped at the server, so this is also how permissions are enforced.
func (p *Peer) SetPublishing(source Source, on bool) {
	r := p.room
	r.mu.Lock()
	defer r.mu.Unlock()
	p.publishing[source] = on
	p.refresh()
}

// SetSilenced applies or lifts a moderator mute.
func (p *Peer) SetSilenced(silenced bool) {
	r := p.room
	r.mu.Lock()
	defer r.mu.Unlock()
	p.silenced = silenced
	p.refresh()
}

// SetDeaf stops or resumes forwarding audio to this participant, which saves
// their bandwidth and enforces moderator deafening.
func (p *Peer) SetDeaf(deaf bool) {
	r := p.room
	r.mu.Lock()
	defer r.mu.Unlock()
	p.deaf = deaf
	r.reconcile()
}

// Watch starts or stops receiving another participant's screen share.
func (p *Peer) Watch(target string, on bool) {
	r := p.room
	r.mu.Lock()
	defer r.mu.Unlock()
	if on {
		p.watching[target] = true
	} else {
		delete(p.watching, target)
	}
	r.reconcile()
}

func (p *Peer) refresh() {
	for source, t := range p.tracks {
		t.active = p.allowed(source)
	}
	p.room.reconcile()
}

// Leave removes the participant from the room and closes their connections.
func (p *Peer) Leave() {
	r := p.room
	r.mu.Lock()
	if p.left {
		r.mu.Unlock()
		return
	}
	p.left = true
	if r.peers[p.id] == p {
		delete(r.peers, p.id)
	}
	r.reconcile()
	r.mu.Unlock()
	p.closeConnections()
	r.engine.dropRoomIfEmpty(r)
}

func (p *Peer) closeConnections() {
	p.failOnce.Do(func() {}) // a deliberate close is not a failure
	p.negMu.Lock()
	p.closed = true
	p.negMu.Unlock()
	p.pub.Close()
	p.sub.Close()
}
