package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"rsc.io/qr"
)

// instanceKey protects secrets the server must be able to read back but which
// should not be usable by someone holding only a copy of the database:
// authenticator secrets and rotating join codes. It lives in its own file.
type instanceKey struct {
	aead cipher.AEAD
	mac  []byte
}

func loadInstanceKey(dataDir string) (*instanceKey, error) {
	path := filepath.Join(dataDir, "instance.key")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		raw = make([]byte, 64)
		if _, err := rand.Read(raw); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if len(raw) != 64 {
		return nil, fmt.Errorf("%s is corrupt: expected 64 bytes", path)
	}
	block, err := aes.NewCipher(raw[:32])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &instanceKey{aead: aead, mac: raw[32:]}, nil
}

func (k *instanceKey) seal(plain []byte, purpose string) ([]byte, error) {
	nonce := make([]byte, k.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return k.aead.Seal(nonce, nonce, plain, []byte(purpose)), nil
}

func (k *instanceKey) open(sealed []byte, purpose string) ([]byte, error) {
	n := k.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("sealed value too short")
	}
	return k.aead.Open(nil, sealed[:n], sealed[n:], []byte(purpose))
}

// derive returns a stable pseudorandom value for a label, used to answer
// sign-in lookups for unknown usernames exactly as for real ones.
func (k *instanceKey) derive(label string, n int) []byte {
	m := hmac.New(sha256.New, k.mac)
	m.Write([]byte(label))
	return m.Sum(nil)[:n]
}

const (
	totpDigits  = 6
	totpPeriod  = 30
	totpSkew    = 1 // steps of clock drift tolerated either way
	secretBytes = 20
)

var base32NoPad = base32.StdEncoding.WithPadding(base32.NoPadding)

func newSecret() ([]byte, error) {
	b := make([]byte, secretBytes)
	_, err := rand.Read(b)
	return b, err
}

// hotp computes an RFC 4226 one-time code.
func hotp(secret []byte, counter int64, digits int) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(counter))
	m := hmac.New(sha1.New, secret)
	m.Write(msg[:])
	sum := m.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	mod := uint32(1)
	for range digits {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%mod)
}

// checkCode compares a code against the time steps around now. It returns the
// matching step so callers can refuse to accept it twice.
func checkCode(secret []byte, code string, period int64, skew int64, at time.Time) (int64, bool) {
	code = strings.TrimSpace(strings.ReplaceAll(code, " ", ""))
	if len(code) != totpDigits {
		return 0, false
	}
	current := at.Unix() / period
	for delta := -skew; delta <= skew; delta++ {
		step := current + delta
		if subtle.ConstantTimeCompare([]byte(hotp(secret, step, totpDigits)), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// otpauthURI is what authenticator apps scan.
func otpauthURI(issuer, account string, secret []byte) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{}
	q.Set("secret", base32NoPad.EncodeToString(secret))
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

func qrDataURI(text string) (string, error) {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", err
	}
	code.Scale = 6
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG()), nil
}

// Recovery codes use an alphabet without look-alike characters.
const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func newRecoveryCodes(n int) (codes []string, hashes [][]byte, err error) {
	for range n {
		raw := make([]byte, 10)
		if _, err := rand.Read(raw); err != nil {
			return nil, nil, err
		}
		var b strings.Builder
		for i, v := range raw {
			if i == 5 {
				b.WriteByte('-')
			}
			b.WriteByte(recoveryAlphabet[int(v)%len(recoveryAlphabet)])
		}
		code := b.String()
		codes = append(codes, code)
		hashes = append(hashes, hashRecoveryCode(code))
	}
	return codes, hashes, nil
}

func hashRecoveryCode(code string) []byte {
	normalized := strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(code))
	sum := sha256.Sum256([]byte("pravda-recovery:" + normalized))
	return sum[:]
}

// envelope is the outer shape of every ciphertext a client sends. The server
// checks only the shape and the key generation; it cannot read the inside.
type envelope struct {
	V   int    `json:"v"`
	E   int    `json:"e"`
	IV  string `json:"iv"`
	CT  string `json:"ct"`
	Sig string `json:"sig"`
}

func parseEnvelope(field, raw string, maxLen int) (envelope, error) {
	var e envelope
	bad := fail(http.StatusBadRequest, "bad_"+field, "The encrypted "+field+" is malformed.")
	if raw == "" || len(raw) > maxLen {
		return e, bad
	}
	if err := json.Unmarshal([]byte(raw), &e); err != nil || e.V != 1 || e.IV == "" || e.CT == "" {
		return e, bad
	}
	for _, part := range []string{e.IV, e.CT, e.Sig} {
		if strings.ContainsAny(part, " \n\t") {
			return e, bad
		}
	}
	return e, nil
}

// checkMeta validates an encrypted name or topic. Empty is allowed where the
// field is optional.
func checkMeta(field, raw string, optional bool) error {
	if raw == "" && optional {
		return nil
	}
	_, err := parseEnvelope(field, raw, maxMetaLen)
	return err
}

const (
	maxMetaLen     = 8192
	maxContentLen  = 96 << 10
	maxReactionLen = 2048
	maxWrappedLen  = 2048
	maxPublicKey   = 512
	maxBundleLen   = 16 << 10
	maxWatchLen    = 8192
)

// validPublicKey checks a base64 SPKI public key's shape.
func validPublicKey(s string) bool {
	if len(s) < 60 || len(s) > maxPublicKey {
		return false
	}
	_, err := base64.StdEncoding.DecodeString(s)
	return err == nil
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
