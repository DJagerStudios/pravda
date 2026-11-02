// Package sfu is Pravda's selective forwarding unit: it receives each
// participant's encoded media and forwards it to the others without decoding
// it. That keeps a call cheap for clients (one upload however many people are
// listening), hides participants' IP addresses from each other, and lets
// moderators cut a stream off at the server.
//
// Every participant holds two peer connections:
//
//	pub  client -> server. The client offers once, up front, with one sending
//	     transceiver per source, then starts and stops media by swapping
//	     tracks. No renegotiation is needed to toggle a camera.
//	sub  server -> client. The server offers whenever the set of forwarded
//	     tracks changes.
//
// Because each connection has a single offerer, offers can never collide.
package sfu

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// Source names one of the four media slots a participant can publish.
type Source string

// The sources a participant can publish.
const (
	SourceMic         Source = "mic"
	SourceCamera      Source = "camera"
	SourceScreen      Source = "screen"
	SourceScreenAudio Source = "screen_audio"
)

// Config selects how the media server is reached.
type Config struct {
	UDPPort   int      // single UDP port for all media
	TCPPort   int      // fallback for networks that block UDP; 0 disables
	PublicIPs []string // advertised instead of local addresses, when behind NAT
	Loopback  bool     // also listen on loopback, for tests and local use
}

// Signal is one WebRTC negotiation message, relayed over the gateway.
type Signal struct {
	PC        string                   `json:"pc"`   // "pub" or "sub"
	Type      string                   `json:"type"` // "offer", "answer" or "candidate"
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	Mids      map[string]Source        `json:"mids,omitempty"` // pub offers: mid -> source
}

// Handler receives what the engine needs to tell the outside world.
type Handler interface {
	// SendSignal delivers a negotiation message to a participant.
	SendSignal(roomID, peerID string, s Signal)
	// Speaking reports a change in who is talking.
	Speaking(roomID, peerID string, speaking bool)
	// PeerFailed reports a participant whose media connection died.
	PeerFailed(roomID, peerID string)
}

// Engine owns the sockets and the rooms.
type Engine struct {
	api     *webrtc.API
	handler Handler
	udpMux  ice.UDPMux
	tcpMux  ice.TCPMux
	tcpLn   net.Listener

	mu    sync.Mutex
	rooms map[string]*Room
}

// New opens the media sockets.
func New(cfg Config, h Handler) (*Engine, error) {
	media := &webrtc.MediaEngine{}
	if err := registerCodecs(media); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(media, registry); err != nil {
		return nil, err
	}

	var settings webrtc.SettingEngine
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	settings.SetICETimeouts(6*time.Second, 20*time.Second, 2*time.Second)
	settings.SetIncludeLoopbackCandidate(cfg.Loopback)

	var muxOpts []ice.UDPMuxFromPortOption
	if cfg.Loopback {
		muxOpts = append(muxOpts, ice.UDPMuxFromPortWithLoopback())
	}
	udpMux, err := ice.NewMultiUDPMuxFromPort(cfg.UDPPort, muxOpts...)
	if err != nil {
		return nil, fmt.Errorf("opening media UDP port %d: %w", cfg.UDPPort, err)
	}
	settings.SetICEUDPMux(udpMux)
	networks := []webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6}

	e := &Engine{handler: h, udpMux: udpMux, rooms: map[string]*Room{}}
	if cfg.TCPPort != 0 {
		ln, err := net.ListenTCP("tcp", &net.TCPAddr{Port: cfg.TCPPort})
		if err != nil {
			udpMux.Close()
			return nil, fmt.Errorf("opening media TCP port %d: %w", cfg.TCPPort, err)
		}
		e.tcpLn = ln
		e.tcpMux = webrtc.NewICETCPMux(nil, ln, 16)
		settings.SetICETCPMux(e.tcpMux)
		networks = append(networks, webrtc.NetworkTypeTCP4, webrtc.NetworkTypeTCP6)
	}
	settings.SetNetworkTypes(networks)

	if len(cfg.PublicIPs) > 0 {
		if err := settings.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External:        cfg.PublicIPs,
			AsCandidateType: webrtc.ICECandidateTypeHost,
			Mode:            webrtc.ICEAddressRewriteReplace,
		}); err != nil {
			e.Close()
			return nil, err
		}
	}

	e.api = webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithSettingEngine(settings), webrtc.WithInterceptorRegistry(registry))
	return e, nil
}

// registerCodecs limits calls to codecs every browser can both send and
// receive. The SFU never transcodes, so all participants must share them. No
// RTX is offered: lost packets are resent in place by the NACK responder.
func registerCodecs(m *webrtc.MediaEngine) error {
	videoFeedback := []webrtc.RTCPFeedback{{Type: "ccm", Parameter: "fir"}}
	codecs := []struct {
		params webrtc.RTPCodecParameters
		kind   webrtc.RTPCodecType
	}{
		{webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1"},
			PayloadType:        111,
		}, webrtc.RTPCodecTypeAudio},
		{webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: videoFeedback},
			PayloadType:        96,
		}, webrtc.RTPCodecTypeVideo},
		{webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP9, ClockRate: 90000, SDPFmtpLine: "profile-id=0", RTCPFeedback: videoFeedback},
			PayloadType:        98,
		}, webrtc.RTPCodecTypeVideo},
	}
	for _, c := range codecs {
		if err := m.RegisterCodec(c.params, c.kind); err != nil {
			return err
		}
	}
	extensions := []struct {
		uri  string
		kind webrtc.RTPCodecType
	}{
		{sdp.AudioLevelURI, webrtc.RTPCodecTypeAudio},
		{sdp.SDESMidURI, webrtc.RTPCodecTypeAudio},
		{sdp.SDESMidURI, webrtc.RTPCodecTypeVideo},
	}
	for _, x := range extensions {
		if err := m.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: x.uri}, x.kind); err != nil {
			return err
		}
	}
	return nil
}

// Close shuts every room and socket down.
func (e *Engine) Close() {
	e.mu.Lock()
	rooms := make([]*Room, 0, len(e.rooms))
	for _, r := range e.rooms {
		rooms = append(rooms, r)
	}
	e.mu.Unlock()
	for _, r := range rooms {
		r.mu.Lock()
		peers := make([]*Peer, 0, len(r.peers))
		for _, p := range r.peers {
			peers = append(peers, p)
		}
		r.mu.Unlock()
		for _, p := range peers {
			p.Leave()
		}
	}
	if e.udpMux != nil {
		e.udpMux.Close()
	}
	if e.tcpMux != nil {
		e.tcpMux.Close()
	}
	if e.tcpLn != nil {
		e.tcpLn.Close()
	}
}

// Join adds a participant to a room, creating the room if needed.
func (e *Engine) Join(roomID, peerID string) (*Peer, error) {
	e.mu.Lock()
	room := e.rooms[roomID]
	if room == nil {
		room = newRoom(e, roomID)
		e.rooms[roomID] = room
	}
	e.mu.Unlock()

	peer, err := newPeer(e, room, peerID)
	if err != nil {
		e.dropRoomIfEmpty(room)
		return nil, err
	}
	room.mu.Lock()
	if _, exists := room.peers[peerID]; exists {
		room.mu.Unlock()
		peer.closeConnections()
		return nil, errors.New("already in this room")
	}
	room.peers[peerID] = peer
	room.reconcile()
	room.mu.Unlock()
	return peer, nil
}

func (e *Engine) dropRoomIfEmpty(r *Room) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.peers) == 0 && e.rooms[r.id] == r {
		delete(e.rooms, r.id)
		r.stop()
	}
}
