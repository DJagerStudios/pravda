// Package id provides Pravda's time-sortable 63-bit identifiers.
//
// Layout: milliseconds since 2026-01-01 UTC in the high bits, a 12-bit counter
// in the low bits. Sorting by ID therefore sorts by creation time, which lets
// message pagination and "last read" tracking use plain integer comparisons.
//
// IDs travel as JSON strings because JavaScript numbers lose precision past 53
// bits.
package id

import (
	"fmt"
	"strconv"
	"sync"
	"time"
)

// ID identifies any Pravda object. Zero means "none".
type ID int64

const (
	epochMillis  = 1767225600000 // 2026-01-01T00:00:00Z
	counterBits  = 12
	counterLimit = 1 << counterBits
)

// String returns the decimal form used in URLs and JSON.
func (i ID) String() string { return strconv.FormatInt(int64(i), 10) }

// Time returns the moment the ID was generated.
func (i ID) Time() time.Time {
	return time.UnixMilli(int64(i)>>counterBits + epochMillis)
}

// MarshalJSON encodes the ID as a JSON string.
func (i ID) MarshalJSON() ([]byte, error) {
	return []byte(`"` + i.String() + `"`), nil
}

// UnmarshalJSON accepts a JSON string, a JSON number or null.
func (i *ID) UnmarshalJSON(b []byte) error {
	s := string(b)
	if s == "null" {
		*i = 0
		return nil
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		s = s[1 : len(s)-1]
	}
	if s == "" {
		*i = 0
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid id %q", s)
	}
	*i = ID(n)
	return nil
}

// MarshalText lets IDs act as JSON object keys.
func (i ID) MarshalText() ([]byte, error) { return []byte(i.String()), nil }

// UnmarshalText lets IDs act as JSON object keys.
func (i *ID) UnmarshalText(b []byte) error {
	n, err := strconv.ParseInt(string(b), 10, 64)
	if err != nil {
		return fmt.Errorf("invalid id %q", string(b))
	}
	*i = ID(n)
	return nil
}

// Parse converts a decimal string into an ID.
func Parse(s string) (ID, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid id %q", s)
	}
	return ID(n), nil
}

// Generator hands out strictly increasing IDs. It is safe for concurrent use.
type Generator struct {
	mu       sync.Mutex
	lastMs   int64
	sequence int64
}

// Next returns a new ID.
func (g *Generator) Next() ID {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now().UnixMilli() - epochMillis
	if now < g.lastMs {
		// The clock went backwards: keep counting from the last timestamp so
		// IDs stay monotonic.
		now = g.lastMs
	}
	if now == g.lastMs {
		g.sequence++
		if g.sequence == counterLimit {
			// 4096 IDs in one millisecond: borrow from the next millisecond.
			g.lastMs++
			g.sequence = 0
			now = g.lastMs
		}
	} else {
		g.lastMs = now
		g.sequence = 0
	}
	return ID(now<<counterBits | g.sequence)
}
