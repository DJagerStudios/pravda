package sfu

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

const (
	// speakingThreshold is the RFC 6464 level (dBov below full scale) that
	// counts as voice. Lower numbers are louder.
	speakingThreshold = 50
	// speakingStreak is how many consecutive loud packets start speech, which
	// filters out single clicks. At 20 ms per packet this is 60 ms.
	speakingStreak = 3
	// speakingHold keeps the indicator lit across the gaps between words.
	speakingHold = 400 * time.Millisecond
	// keyframeInterval limits how often a publisher is asked for a keyframe.
	keyframeInterval = 500 * time.Millisecond
	rtpBufferSize    = 1500
)

// Room is one call: everyone in it can hear everyone else.
type Room struct {
	id     string
	engine *Engine

	mu    sync.Mutex
	peers map[string]*Peer

	stopOnce sync.Once
	done     chan struct{}
}

func newRoom(e *Engine, id string) *Room {
	r := &Room{id: id, engine: e, peers: map[string]*Peer{}, done: make(chan struct{})}
	go r.speakingLoop()
	return r
}

func (r *Room) stop() { r.stopOnce.Do(func() { close(r.done) }) }

// speakingLoop turns per-packet audio levels into start and stop events. It
// runs on a timer because stopped audio produces no packets to react to.
func (r *Room) speakingLoop() {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-r.done:
			return
		case <-ticker.C:
		}
		type change struct {
			peer     string
			speaking bool
		}
		var changes []change
		now := time.Now().UnixNano()
		r.mu.Lock()
		for _, p := range r.peers {
			t := p.tracks[SourceMic]
			speaking := t != nil && t.active && now-t.lastLoud.Load() < int64(speakingHold)
			if speaking != p.speaking {
				p.speaking = speaking
				changes = append(changes, change{p.id, speaking})
			}
		}
		r.mu.Unlock()
		for _, c := range changes {
			r.engine.handler.Speaking(r.id, c.peer, c.speaking)
		}
	}
}

// reconcile makes every participant's forwarded tracks match what they should
// be receiving. All state changes funnel through here, so there is one place
// that decides who gets what. Callers hold r.mu.
func (r *Room) reconcile() {
	for _, viewer := range r.peers {
		changed := false
		for t, sub := range viewer.subs {
			if !r.shouldForward(viewer, t) {
				viewer.removeSub(t, sub)
				changed = true
			}
		}
		for _, publisher := range r.peers {
			if publisher == viewer {
				continue
			}
			for _, t := range publisher.tracks {
				if _, have := viewer.subs[t]; !have && r.shouldForward(viewer, t) {
					if viewer.addSub(t) {
						changed = true
					}
				}
			}
		}
		for t, sub := range viewer.subs {
			sub.paused.Store(viewer.deaf && t.kind == webrtc.RTPCodecTypeAudio)
		}
		if changed {
			go viewer.negotiate()
		}
	}
}

func (r *Room) shouldForward(viewer *Peer, t *pubTrack) bool {
	if !t.active || t.closed.Load() || t.peer == viewer || r.peers[t.peer.id] != t.peer {
		return false
	}
	switch t.source {
	case SourceScreen, SourceScreenAudio:
		// Screens are opt-in: they cost far more bandwidth than anything else.
		return viewer.watching[t.peer.id]
	}
	return true
}

// pubTrack is one incoming media stream and the fan-out to its subscribers.
type pubTrack struct {
	peer     *Peer
	source   Source
	remote   *webrtc.TrackRemote
	kind     webrtc.RTPCodecType
	levelExt uint8

	// active, guarded by the room lock: the publisher declared this source on
	// and is allowed to send it.
	active bool
	closed atomic.Bool

	subs       atomic.Pointer[[]*subTrack]
	lastLoud   atomic.Int64
	streak     int // loud packets in a row; read loop only
	lastKeyReq atomic.Int64
}

func (t *pubTrack) setSubs(update func([]*subTrack) []*subTrack) {
	var current []*subTrack
	if p := t.subs.Load(); p != nil {
		current = *p
	}
	next := update(append([]*subTrack(nil), current...))
	t.subs.Store(&next)
}

// run forwards packets until the publisher stops. Each subscriber writes to
// its own track, so one slow or paused subscriber never affects the others.
func (t *pubTrack) run() {
	buf := make([]byte, rtpBufferSize)
	var pkt rtp.Packet
	for {
		n, _, err := t.remote.Read(buf)
		if err != nil {
			return
		}
		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}
		if t.levelExt != 0 {
			t.observeLevel(&pkt)
		}
		// Extension IDs are negotiated per connection, so they mean nothing
		// to subscribers.
		pkt.Header.Extension = false
		pkt.Header.Extensions = nil
		subs := t.subs.Load()
		if subs == nil {
			continue
		}
		for _, s := range *subs {
			if !s.paused.Load() {
				// A write can only fail if the subscriber is going away, and
				// reconcile removes them.
				_ = s.local.WriteRTP(&pkt)
			}
		}
	}
}

func (t *pubTrack) observeLevel(pkt *rtp.Packet) {
	raw := pkt.GetExtension(t.levelExt)
	if len(raw) == 0 {
		return
	}
	var level rtp.AudioLevelExtension
	if level.Unmarshal(raw) != nil {
		return
	}
	if level.Level > speakingThreshold {
		t.streak = 0
		return
	}
	t.streak++
	if t.streak >= speakingStreak {
		t.lastLoud.Store(time.Now().UnixNano())
	}
}

// requestKeyframe asks the publisher for a full frame, which is what lets a
// new viewer start decoding.
func (t *pubTrack) requestKeyframe() {
	if t.kind != webrtc.RTPCodecTypeVideo {
		return
	}
	now := time.Now().UnixNano()
	last := t.lastKeyReq.Load()
	if now-last < int64(keyframeInterval) || !t.lastKeyReq.CompareAndSwap(last, now) {
		return
	}
	_ = t.peer.pub.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(t.remote.SSRC())}})
}

// subTrack is one subscriber's copy of a pubTrack.
type subTrack struct {
	track  *pubTrack
	local  *webrtc.TrackLocalStaticRTP
	sender *webrtc.RTPSender
	paused atomic.Bool
}

// readRTCP relays viewers' keyframe requests to the publisher. Reading is also
// what keeps the NACK responder interceptor running.
func (s *subTrack) readRTCP() {
	for {
		packets, _, err := s.sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, p := range packets {
			switch p.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				s.track.requestKeyframe()
			}
		}
	}
}

func audioLevelExtension(receiver *webrtc.RTPReceiver) uint8 {
	for _, x := range receiver.GetParameters().HeaderExtensions {
		if x.URI == sdp.AudioLevelURI {
			return uint8(x.ID)
		}
	}
	return 0
}
