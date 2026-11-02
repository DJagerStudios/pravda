package perm

import (
	"testing"

	"pravda/internal/id"
)

const (
	server id.ID = 1
	owner  id.ID = 10
	alice  id.ID = 11
	bob    id.ID = 12
	admin  id.ID = 13
	mod    id.ID = 2
	muted  id.ID = 3
	adminR id.ID = 4
	cat    id.ID = 100
	text   id.ID = 101
	secret id.ID = 102
)

func fixture() *Snapshot {
	return &Snapshot{
		ServerID: server,
		OwnerID:  owner,
		Roles: map[id.ID]Role{
			server: {ID: server, Position: 0, Perms: Default},
			mod:    {ID: mod, Position: 5, Perms: ManageMessages | KickMembers},
			muted:  {ID: muted, Position: 1},
			adminR: {ID: adminR, Position: 9, Perms: Administrator},
		},
		Members: map[id.ID][]id.ID{
			owner: nil,
			alice: {mod},
			bob:   {muted},
			admin: {adminR},
		},
		Overwrites: map[id.ID][]Overwrite{
			text:   {{Target: muted, Deny: SendMessages}},
			secret: {{Target: server, Deny: ViewChannel}, {Target: mod, Allow: ViewChannel}},
			cat:    {{Target: server, Deny: AddReactions}},
		},
		Parents: map[id.ID]id.ID{text: cat, secret: cat},
	}
}

func TestBaseIsUnionOfRoles(t *testing.T) {
	s := fixture()
	p := s.Base(alice)
	if !p.Has(ManageMessages) || !p.Has(SendMessages) {
		t.Fatalf("expected base and role bits, got %b", p)
	}
	if s.Base(999) != 0 {
		t.Fatal("non-members must have no rights")
	}
}

func TestOwnerAndAdministratorBypassOverwrites(t *testing.T) {
	s := fixture()
	if s.Channel(owner, secret) != All {
		t.Fatal("owner should hold everything")
	}
	if s.Channel(admin, secret) != All {
		t.Fatal("administrators bypass overwrites")
	}
}

func TestChannelDenyAndAllow(t *testing.T) {
	s := fixture()
	if s.Channel(bob, text).Has(SendMessages) {
		t.Fatal("role deny should remove sending")
	}
	if !s.Channel(bob, text).Has(ViewChannel) {
		t.Fatal("deny of sending must leave viewing intact")
	}
	if s.Channel(bob, secret) != 0 {
		t.Fatal("no view means no rights at all")
	}
	if !s.Channel(alice, secret).Has(ViewChannel) {
		t.Fatal("role allow should beat the base role deny")
	}
}

func TestRoleAllowBeatsRoleDeny(t *testing.T) {
	s := fixture()
	s.Overwrites[text] = []Overwrite{{Target: mod, Deny: SendMessages}, {Target: muted, Allow: SendMessages}}
	s.Members[bob] = []id.ID{mod, muted}
	if !s.Channel(bob, text).Has(SendMessages) {
		t.Fatal("within the role layer an allow wins over a deny")
	}
}

func TestMemberOverwriteHasFinalSay(t *testing.T) {
	s := fixture()
	s.Overwrites[text] = append(s.Overwrites[text], Overwrite{Member: true, Target: bob, Allow: SendMessages})
	if !s.Channel(bob, text).Has(SendMessages) {
		t.Fatal("member allow should override the role deny")
	}
	s.Overwrites[secret] = append(s.Overwrites[secret], Overwrite{Member: true, Target: alice, Deny: ViewChannel})
	if s.Channel(alice, secret).Has(ViewChannel) {
		t.Fatal("member deny should override the role allow")
	}
}

func TestCategoryLayersRunFirst(t *testing.T) {
	s := fixture()
	if s.Channel(alice, text).Has(AddReactions) {
		t.Fatal("category deny should reach child channels")
	}
	s.Overwrites[text] = []Overwrite{{Target: server, Allow: AddReactions}}
	if !s.Channel(alice, text).Has(AddReactions) {
		t.Fatal("a channel should be able to undo its category")
	}
}

func TestImpliedVoiceAndAttachRules(t *testing.T) {
	s := fixture()
	s.Overwrites[text] = []Overwrite{{Target: server, Deny: VoiceConnect | SendMessages}}
	p := s.Channel(alice, text)
	if p.Has(VoiceSpeak) || p.Has(VoiceVideo) {
		t.Fatal("no connect means no speaking or video")
	}
	if p.Has(AttachFiles) {
		t.Fatal("no sending means no attachments")
	}
}

func TestViewersOnlyListsThoseWhoCanSee(t *testing.T) {
	got := fixture().Viewers(secret)
	want := []id.ID{owner, alice, admin}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestHierarchy(t *testing.T) {
	s := fixture()
	if !s.Outranks(admin, alice) || s.Outranks(alice, admin) {
		t.Fatal("higher role must outrank lower")
	}
	if s.Outranks(alice, alice) {
		t.Fatal("equal rank must not outrank")
	}
	if s.Outranks(admin, owner) || s.Outranks(owner, owner) {
		t.Fatal("nobody outranks the owner")
	}
	if !s.Outranks(owner, admin) {
		t.Fatal("owner outranks everyone")
	}
	if s.CanManageRole(alice, adminR) || !s.CanManageRole(admin, mod) || !s.CanManageRole(owner, adminR) {
		t.Fatal("role management must follow rank")
	}
}
