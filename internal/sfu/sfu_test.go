package sfu

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// recorder is a Handler that routes signals to fake clients.
type recorder struct {
	mu       sync.Mutex
	clients  map[string]*client
	speaking map[string]bool
	failures atomic.Int32
}

func (r *recorder) SendSignal(_, peerID string, s Signal) {
	r.mu.Lock()
	c := r.clients[peerID]
	r.mu.Unlock()
	if c != nil {
		c.signals <- s
	}
}

func (r *recorder) Speaking(_, peerID string, speaking bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.speaking[peerID] = speaking
}

func (r *recorder) isSpeaking(peer string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.speaking[peer]
}

func (r *recorder) PeerFailed(string, string) { r.failures.Add(1) }

// client plays the part of a browser using Pion on the other side.
type client struct {
	t       *testing.T
	id      string
	pub     *webrtc.PeerConnection
	sub     *webrtc.PeerConnection
	peer    *Peer
	signals chan Signal

	audio *webrtc.TrackLocalStaticRTP
	video *webrtc.TrackLocalStaticSample

	hungUp atomic.Bool

	mu       sync.Mutex
	received map[string]*atomic.Int64 // stream id -> packets
}

func freePort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func newEngine(t *testing.T) (*Engine, *recorder) {
	t.Helper()
	h := &recorder{clients: map[string]*client{}, speaking: map[string]bool{}}
	e, err := New(Config{UDPPort: freePort(t), Loopback: true}, h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Close)
	return e, h
}

func clientAPI(t *testing.T) *webrtc.API {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := registerCodecs(m); err != nil {
		t.Fatal(err)
	}
	var s webrtc.SettingEngine
	s.SetIncludeLoopbackCandidate(true)
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(s))
}

func join(t *testing.T, e *Engine, h *recorder, roomID, id string) *client {
	t.Helper()
	api := clientAPI(t)
	pub, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	sub, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	c := &client{t: t, id: id, pub: pub, sub: sub, signals: make(chan Signal, 32), received: map[string]*atomic.Int64{}}
	t.Cleanup(func() {
		c.hungUp.Store(true)
		pub.Close()
		sub.Close()
	})

	h.mu.Lock()
	h.clients[id] = c
	h.mu.Unlock()

	if c.peer, err = e.Join(roomID, id); err != nil {
		t.Fatal(err)
	}

	sub.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		counter := &atomic.Int64{}
		c.mu.Lock()
		c.received[remote.StreamID()] = counter
		c.mu.Unlock()
		for {
			if _, _, err := remote.ReadRTP(); err != nil {
				return
			}
			counter.Add(1)
		}
	})

	c.audio, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "local")
	if err != nil {
		t.Fatal(err)
	}
	c.video, err = webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", "local")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pub.AddTransceiverFromTrack(c.audio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatal(err)
	}
	if _, err := pub.AddTransceiverFromTrack(c.video, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatal(err)
	}
	offer, err := pub.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pub)
	if err := pub.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	mids := map[string]Source{}
	for _, tr := range pub.GetTransceivers() {
		if tr.Kind() == webrtc.RTPCodecTypeAudio {
			mids[tr.Mid()] = SourceMic
		} else {
			mids[tr.Mid()] = SourceCamera
		}
	}
	if err := c.peer.HandleSignal(Signal{PC: "pub", Type: "offer", SDP: pub.LocalDescription().SDP, Mids: mids}); err != nil {
		t.Fatal(err)
	}
	go c.signalLoop()
	return c
}

// fail reports a negotiation error unless the client has already hung up, in
// which case late signals are expected.
func (c *client) fail(step string, err error) {
	if !c.hungUp.Load() {
		c.t.Errorf("%s: %s: %v", c.id, step, err)
	}
}

func (c *client) signalLoop() {
	for s := range c.signals {
		switch {
		case s.PC == "pub" && s.Type == "answer":
			if err := c.pub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: s.SDP}); err != nil {
				c.fail("pub answer", err)
			}
		case s.PC == "sub" && s.Type == "offer":
			if err := c.sub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: s.SDP}); err != nil {
				c.fail("sub offer", err)
				continue
			}
			answer, err := c.sub.CreateAnswer(nil)
			if err != nil {
				c.fail("sub answer", err)
				continue
			}
			gathered := webrtc.GatheringCompletePromise(c.sub)
			if err := c.sub.SetLocalDescription(answer); err != nil {
				c.fail("set sub answer", err)
				continue
			}
			<-gathered
			if err := c.peer.HandleSignal(Signal{PC: "sub", Type: "answer", SDP: c.sub.LocalDescription().SDP}); err != nil {
				c.t.Logf("%s: sub answer rejected: %v", c.id, err)
			}
		}
	}
}

// streamMedia sends fake Opus and VP8 until stopped. Opus payloads carry an
// RFC 6464 level so speaking detection has something to read.
func (c *client) streamMedia(loud *atomic.Bool) (stop func()) {
	done := make(chan struct{})
	go func() {
		seq := uint16(1)
		ts := uint32(0)
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for i := 0; ; i++ {
			select {
			case <-done:
				return
			case <-tick.C:
			}
			pkt := &rtp.Packet{
				Header:  rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: ts, SSRC: 1},
				Payload: []byte{0xf8, 0xff, 0xfe},
			}
			seq++
			ts += 960
			_ = c.audio.WriteRTP(pkt)
			if i%3 == 0 {
				_ = c.video.WriteSample(media.Sample{Data: []byte{0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a}, Duration: 60 * time.Millisecond})
			}
		}
	}()
	return func() { close(done) }
}

func (c *client) packets(stream string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := c.received[stream]; n != nil {
		return n.Load()
	}
	return 0
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func stream(peer string, s Source) string { return fmt.Sprintf("%s:%s", peer, s) }

func TestForwardsAudioAndVideoBetweenParticipants(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	bob := join(t, e, h, "room", "bob")
	alice.peer.SetPublishing(SourceMic, true)
	alice.peer.SetPublishing(SourceCamera, true)
	bob.peer.SetPublishing(SourceMic, true)

	defer alice.streamMedia(nil)()
	defer bob.streamMedia(nil)()

	waitFor(t, "bob hearing alice", func() bool { return bob.packets(stream("alice", SourceMic)) > 10 })
	waitFor(t, "bob seeing alice", func() bool { return bob.packets(stream("alice", SourceCamera)) > 3 })
	waitFor(t, "alice hearing bob", func() bool { return alice.packets(stream("bob", SourceMic)) > 10 })

	if n := alice.packets(stream("bob", SourceCamera)); n != 0 {
		t.Fatalf("bob never declared a camera but %d packets arrived", n)
	}
	if n := alice.packets(stream("alice", SourceMic)); n != 0 {
		t.Fatalf("alice heard herself: %d packets", n)
	}
}

func TestLateJoinerReceivesExistingStreams(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	alice.peer.SetPublishing(SourceMic, true)
	defer alice.streamMedia(nil)()
	waitFor(t, "alice's track", func() bool {
		alice.peer.room.mu.Lock()
		defer alice.peer.room.mu.Unlock()
		return alice.peer.tracks[SourceMic] != nil
	})
	bob := join(t, e, h, "room", "bob")
	waitFor(t, "late joiner hearing alice", func() bool { return bob.packets(stream("alice", SourceMic)) > 10 })
}

func TestScreenShareIsOptIn(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	bob := join(t, e, h, "room", "bob")

	// Alice's video slot plays the role of a screen here.
	alice.peer.room.mu.Lock()
	for mid, source := range alice.peer.mids {
		if source == SourceCamera {
			alice.peer.mids[mid] = SourceScreen
		}
	}
	alice.peer.room.mu.Unlock()
	alice.peer.SetPublishing(SourceScreen, true)
	defer alice.streamMedia(nil)()

	time.Sleep(600 * time.Millisecond)
	if n := bob.packets(stream("alice", SourceScreen)); n != 0 {
		t.Fatalf("screen reached a viewer who did not ask: %d packets", n)
	}
	bob.peer.Watch("alice", true)
	waitFor(t, "watcher receiving the screen", func() bool { return bob.packets(stream("alice", SourceScreen)) > 3 })
}

func TestModeratorMuteStopsAudioAtTheServer(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	bob := join(t, e, h, "room", "bob")
	alice.peer.SetPublishing(SourceMic, true)
	defer alice.streamMedia(nil)()
	waitFor(t, "audio flowing", func() bool { return bob.packets(stream("alice", SourceMic)) > 10 })

	alice.peer.SetSilenced(true)
	time.Sleep(300 * time.Millisecond)
	before := bob.packets(stream("alice", SourceMic))
	time.Sleep(400 * time.Millisecond)
	if after := bob.packets(stream("alice", SourceMic)); after > before+1 {
		t.Fatalf("muted audio kept flowing: %d -> %d", before, after)
	}
}

func TestDeafenedParticipantReceivesNoAudio(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	bob := join(t, e, h, "room", "bob")
	alice.peer.SetPublishing(SourceMic, true)
	defer alice.streamMedia(nil)()
	waitFor(t, "audio flowing", func() bool { return bob.packets(stream("alice", SourceMic)) > 10 })

	bob.peer.SetDeaf(true)
	time.Sleep(200 * time.Millisecond)
	before := bob.packets(stream("alice", SourceMic))
	time.Sleep(400 * time.Millisecond)
	if after := bob.packets(stream("alice", SourceMic)); after > before+1 {
		t.Fatalf("deafened peer kept receiving: %d -> %d", before, after)
	}
	bob.peer.SetDeaf(false)
	waitFor(t, "audio resuming", func() bool { return bob.packets(stream("alice", SourceMic)) > before+10 })
}

func TestUndeclaredSourceIsNotForwarded(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	bob := join(t, e, h, "room", "bob")
	// Alice sends without ever declaring a source: a client bypassing the
	// permission check on the gateway must not reach anyone.
	defer alice.streamMedia(nil)()
	time.Sleep(700 * time.Millisecond)
	if n := bob.packets(stream("alice", SourceMic)) + bob.packets(stream("alice", SourceCamera)); n != 0 {
		t.Fatalf("undeclared media was forwarded: %d packets", n)
	}
}

func TestLeaveStopsForwardingAndCleansUp(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	bob := join(t, e, h, "room", "bob")
	alice.peer.SetPublishing(SourceMic, true)
	defer alice.streamMedia(nil)()
	waitFor(t, "audio flowing", func() bool { return bob.packets(stream("alice", SourceMic)) > 10 })

	alice.peer.Leave()
	alice.peer.Leave() // must be safe to repeat
	time.Sleep(200 * time.Millisecond)
	before := bob.packets(stream("alice", SourceMic))
	time.Sleep(300 * time.Millisecond)
	if after := bob.packets(stream("alice", SourceMic)); after > before+1 {
		t.Fatalf("audio kept flowing after leave: %d -> %d", before, after)
	}
	bob.peer.Leave()
	e.mu.Lock()
	rooms := len(e.rooms)
	e.mu.Unlock()
	if rooms != 0 {
		t.Fatalf("empty room was not removed: %d left", rooms)
	}
}

func TestClientHangupIsReported(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	alice.peer.SetPublishing(SourceMic, true)
	stop := alice.streamMedia(nil)
	defer stop()
	waitFor(t, "alice connected", func() bool {
		return alice.pub.ConnectionState() == webrtc.PeerConnectionStateConnected
	})
	alice.pub.Close()
	waitFor(t, "the hangup to be noticed", func() bool { return h.failures.Load() == 1 })
}

func TestDeliberateLeaveIsNotAFailure(t *testing.T) {
	e, h := newEngine(t)
	alice := join(t, e, h, "room", "alice")
	waitFor(t, "alice connected", func() bool {
		return alice.pub.ConnectionState() == webrtc.PeerConnectionStateConnected
	})
	alice.peer.Leave()
	time.Sleep(300 * time.Millisecond)
	if n := h.failures.Load(); n != 0 {
		t.Fatalf("a normal leave was reported as %d failures", n)
	}
}

func TestSignalRoundTripsThroughJSON(t *testing.T) {
	in := Signal{PC: "pub", Type: "offer", SDP: "v=0", Mids: map[string]Source{"0": SourceMic}}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out Signal
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.Mids["0"] != SourceMic || out.SDP != "v=0" {
		t.Fatalf("round trip lost data: %+v", out)
	}
}
