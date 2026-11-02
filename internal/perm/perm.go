// Package perm computes what a member may do.
//
// The model: every server has an implicit base role, members hold any number
// of further roles, and channels and categories may carry per-role or
// per-member overwrites. A member's server-wide rights are the union of their
// roles. Overwrites are then applied in layers, each layer removing its
// denied bits and adding its allowed bits, from the broadest target to the
// narrowest: base role, the member's other roles taken together, the member.
// A category's layers run first, so a channel can refine what its category
// set.
package perm

import (
	"sort"

	"pravda/internal/id"
)

// Perm is a set of permission bits.
type Perm uint64

// Permission bits. Values are stored in the database, so append only.
const (
	ViewChannel Perm = 1 << iota
	SendMessages
	ReadHistory
	AttachFiles
	AddReactions
	MentionEveryone
	ManageMessages
	ManageChannels
	ManageRoles
	ManageServer
	CreateInvites
	KickMembers
	BanMembers
	ViewAudit
	ChangeNickname
	ManageNicknames
	VoiceConnect
	VoiceSpeak
	VoiceVideo
	VoiceStream
	VoiceMuteOthers
	VoiceDeafenOthers
	VoiceMoveOthers
	Administrator
	// ManageMessagesPinOnly lets DM participants pin without gaining the
	// right to delete each other's messages.
	ManageMessagesPinOnly
)

// All holds every defined permission.
const All Perm = ManageMessagesPinOnly<<1 - 1

// Default is what the base role of a new server grants.
const Default = ViewChannel | SendMessages | ReadHistory | AttachFiles | AddReactions |
	CreateInvites | ChangeNickname | VoiceConnect | VoiceSpeak | VoiceVideo | VoiceStream

// Has reports whether every bit in q is set.
func (p Perm) Has(q Perm) bool { return p&q == q }

// Role is the part of a role the calculation needs.
type Role struct {
	ID       id.ID
	Position int
	Perms    Perm
}

// Overwrite adjusts one role's or one member's rights on a channel.
type Overwrite struct {
	Member bool // false: Target is a role
	Target id.ID
	Allow  Perm
	Deny   Perm
}

// Snapshot is an immutable view of one server's permission data.
type Snapshot struct {
	ServerID   id.ID
	OwnerID    id.ID
	Roles      map[id.ID]Role    // includes the base role, whose ID equals ServerID
	Members    map[id.ID][]id.ID // user -> held role IDs (base role not listed)
	Overwrites map[id.ID][]Overwrite
	Parents    map[id.ID]id.ID // channel -> category
}

// IsMember reports whether the user belongs to the server.
func (s *Snapshot) IsMember(user id.ID) bool {
	_, ok := s.Members[user]
	return ok
}

// Base returns the member's server-wide rights.
func (s *Snapshot) Base(user id.ID) Perm {
	roles, ok := s.Members[user]
	if !ok {
		return 0
	}
	if user == s.OwnerID {
		return All
	}
	p := s.Roles[s.ServerID].Perms
	for _, r := range roles {
		p |= s.Roles[r].Perms
	}
	if p.Has(Administrator) {
		return All
	}
	return p
}

// Channel returns the member's effective rights in a channel.
func (s *Snapshot) Channel(user, channel id.ID) Perm {
	base := s.Base(user)
	if base == 0 {
		return 0
	}
	if base.Has(Administrator) {
		return All
	}
	p := base
	if parent := s.Parents[channel]; parent != 0 {
		p = s.applyLayers(p, user, parent)
	}
	p = s.applyLayers(p, user, channel)
	return implied(p)
}

func (s *Snapshot) applyLayers(p Perm, user, channel id.ID) Perm {
	overwrites := s.Overwrites[channel]
	if len(overwrites) == 0 {
		return p
	}
	held := map[id.ID]bool{}
	for _, r := range s.Members[user] {
		held[r] = true
	}
	var roleAllow, roleDeny Perm
	var member *Overwrite
	var everyone *Overwrite
	for i := range overwrites {
		o := &overwrites[i]
		switch {
		case o.Member && o.Target == user:
			member = o
		case o.Member:
		case o.Target == s.ServerID:
			everyone = o
		case held[o.Target]:
			roleAllow |= o.Allow
			roleDeny |= o.Deny
		}
	}
	if everyone != nil {
		p = p&^everyone.Deny | everyone.Allow
	}
	p = p&^roleDeny | roleAllow
	if member != nil {
		p = p&^member.Deny | member.Allow
	}
	return p
}

// implied removes rights that make no sense without another right.
func implied(p Perm) Perm {
	if !p.Has(ViewChannel) {
		return 0
	}
	if !p.Has(SendMessages) {
		p &^= AttachFiles | MentionEveryone
	}
	if !p.Has(VoiceConnect) {
		p &^= VoiceSpeak | VoiceVideo | VoiceStream | VoiceMuteOthers | VoiceDeafenOthers | VoiceMoveOthers
	}
	return p
}

// Viewers lists the members who can see a channel, sorted for stable output.
func (s *Snapshot) Viewers(channel id.ID) []id.ID {
	out := make([]id.ID, 0, len(s.Members))
	for user := range s.Members {
		if s.Channel(user, channel).Has(ViewChannel) {
			out = append(out, user)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// MemberIDs lists all members.
func (s *Snapshot) MemberIDs() []id.ID {
	out := make([]id.ID, 0, len(s.Members))
	for user := range s.Members {
		out = append(out, user)
	}
	return out
}

// TopPosition returns the position of the member's highest role. The owner
// outranks every role.
func (s *Snapshot) TopPosition(user id.ID) int {
	if user == s.OwnerID {
		return 1 << 30
	}
	top := 0
	for _, r := range s.Members[user] {
		if p := s.Roles[r].Position; p > top {
			top = p
		}
	}
	return top
}

// Outranks reports whether actor may act on target, which requires a strictly
// higher role. Nobody outranks the owner, including themselves.
func (s *Snapshot) Outranks(actor, target id.ID) bool {
	if target == s.OwnerID {
		return false
	}
	return s.TopPosition(actor) > s.TopPosition(target)
}

// CanManageRole reports whether actor may edit, grant or remove a role.
func (s *Snapshot) CanManageRole(actor, role id.ID) bool {
	if actor == s.OwnerID {
		return true
	}
	return s.TopPosition(actor) > s.Roles[role].Position
}
