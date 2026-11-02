package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"pravda/internal/id"
	"pravda/internal/perm"
	"pravda/internal/store"
)

const (
	maxPublicImageBytes = 8 << 20
	sniffBytes          = 512
)

// publicImageTypes are the formats allowed for avatars and server icons.
var publicImageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// inlineTypes may be displayed by the browser. Everything else downloads, so
// an uploaded HTML or SVG file can never run on this origin.
var inlineTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/bmp": true,
	"video/mp4": true, "video/webm": true, "audio/mpeg": true, "audio/ogg": true, "audio/wave": true,
	"audio/webm": true, "audio/flac": true, "audio/aac": true, "audio/mp4": true,
}

// detectType decides a file's type from its content. The client's claim is
// ignored, as is the extension except to tell apart containers that share
// the same signature.
func detectType(head []byte, filename string) string {
	detected := http.DetectContentType(head)
	base, _, err := mime.ParseMediaType(detected)
	if err != nil {
		return "application/octet-stream"
	}
	ext := strings.ToLower(filepath.Ext(filename))
	switch {
	case base == "application/ogg":
		if ext == ".ogv" {
			return "video/ogg"
		}
		return "audio/ogg"
	case base == "video/webm" && ext == ".weba":
		return "audio/webm"
	case base == "video/mp4" && (ext == ".m4a" || ext == ".aac"):
		return "audio/mp4"
	case base == "application/octet-stream" && ext == ".flac" && bytes.HasPrefix(head, []byte("fLaC")):
		return "audio/flac"
	}
	return base
}

func cleanFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, filepath.Base(name))
	name = strings.TrimSpace(strings.TrimLeft(name, "."))
	if name == "" || name == "/" {
		return "file"
	}
	if utf8.RuneCountInString(name) > 200 {
		ext := filepath.Ext(name)
		if utf8.RuneCountInString(ext) > 20 {
			ext = ""
		}
		name = string([]rune(strings.TrimSuffix(name, ext))[:200]) + ext
	}
	return name
}

func (s *Server) mediaPath(attachment id.ID) string {
	name := attachment.String()
	return filepath.Join(s.cfg.DataDir, "uploads", name[len(name)-2:], name)
}

func (s *Server) removeFiles(files []id.ID) {
	for _, f := range files {
		if err := os.Remove(s.mediaPath(f)); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("removing upload", "err", err)
		}
	}
}

// mediaURL is where a client fetches an attachment.
func mediaURL(a store.Attachment) string {
	return "/media/" + a.ID.String() + "/" + url.PathEscape(a.Filename)
}

// upload streams a raw request body to disk. Message uploads wait in limbo
// until a message claims them; the janitor removes any that never do.
func (s *Server) upload(w http.ResponseWriter, r *http.Request, auth Auth) error {
	if !s.uploadLimit.allow(auth.User.String()) {
		return errRate
	}
	kind := r.URL.Query().Get("kind")
	limit := s.cfg.MaxUploadBytes
	var serverID id.ID
	switch kind {
	case "", "message":
		kind = "message"
	case "public":
		limit = maxPublicImageBytes
	case "server":
		// An encrypted server icon: only its members will be able to fetch it.
		limit = maxPublicImageBytes
		var err error
		if serverID, err = queryID(r, "server"); err != nil || serverID == 0 {
			return fail(http.StatusBadRequest, "bad_server", "Say which server this image belongs to.")
		}
		_, base, err := s.requireServer(r.Context(), serverID, auth.User)
		if err != nil {
			return err
		}
		if !base.Has(perm.ManageServer) {
			return errForbidden
		}
	default:
		return fail(http.StatusBadRequest, "bad_kind", "Unknown upload kind.")
	}
	encrypted := kind != "public"
	filename := cleanFilename(r.URL.Query().Get("filename"))
	if encrypted {
		// The real name and type are inside the encrypted message.
		filename = "encrypted"
	}
	body := http.MaxBytesReader(w, r.Body, limit)

	attachment := s.db.IDs.Next()
	final := s.mediaPath(attachment)
	if err := os.MkdirAll(filepath.Dir(final), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(final), "upload-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	head := make([]byte, sniffBytes)
	n, err := io.ReadFull(body, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}
	head = head[:n]
	if n == 0 {
		return fail(http.StatusBadRequest, "empty_file", "That file is empty.")
	}
	mimeType := "application/octet-stream"
	if !encrypted {
		mimeType = detectType(head, filename)
		if !publicImageTypes[mimeType] {
			return fail(http.StatusBadRequest, "bad_image", "Use a PNG, JPEG, GIF or WebP image.")
		}
	}
	if _, err := tmp.Write(head); err != nil {
		return err
	}
	size, err := io.Copy(tmp, body)
	if err != nil {
		return err
	}
	size += int64(n)
	if err := tmp.Close(); err != nil {
		return err
	}

	a := store.Attachment{
		ID: attachment, UploaderID: auth.User, ServerID: serverID, Kind: kind, Filename: filename,
		Mime: mimeType, Size: size, CreatedAt: time.Now().UnixMilli(),
	}
	if !encrypted && strings.HasPrefix(mimeType, "image/") {
		if f, err := os.Open(tmp.Name()); err == nil {
			if cfg, _, err := image.DecodeConfig(f); err == nil {
				a.Width, a.Height = cfg.Width, cfg.Height
			}
			f.Close()
		}
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return err
	}
	if err := s.db.CreateAttachment(r.Context(), a); err != nil {
		os.Remove(final)
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": a.ID, "url": mediaURL(a), "filename": a.Filename, "mime": a.Mime, "size": a.Size,
		"width": a.Width, "height": a.Height,
	})
	return nil
}

// canReadAttachment applies the access rules for a file.
func (s *Server) canReadAttachment(ctx context.Context, a store.Attachment, auth Auth, authed bool) (bool, error) {
	if a.Kind == "public" {
		return true, nil
	}
	if !authed {
		return false, nil
	}
	if a.Kind == "server" {
		snap, err := s.snapshot(ctx, a.ServerID)
		if err != nil {
			return false, err
		}
		return snap.IsMember(auth.User), nil
	}
	if a.MessageID == 0 {
		return a.UploaderID == auth.User, nil
	}
	m, err := s.db.GetMessage(ctx, a.MessageID)
	if err != nil {
		return false, err
	}
	c, err := s.db.GetChannel(ctx, m.ChannelID)
	if err != nil {
		return false, err
	}
	perms, err := s.channelPerms(ctx, auth.User, c)
	if err != nil {
		return false, err
	}
	return perms.Has(perm.ViewChannel | perm.ReadHistory), nil
}

// handleMedia serves uploads. The CSP sandbox and nosniff headers mean that
// even a file the type check misjudged cannot script this origin.
func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	attachment, err := pathID(r, "id")
	if err != nil {
		writeError(w, errNotFound)
		return
	}
	ctx := r.Context()
	a, err := s.db.GetAttachment(ctx, attachment)
	if err != nil {
		writeError(w, errNotFound)
		return
	}
	auth, _, authErr := s.authenticate(r)
	allowed, err := s.canReadAttachment(ctx, a, auth, authErr == nil)
	if err != nil {
		writeError(w, err)
		return
	}
	if !allowed {
		// Same answer as a missing file, so IDs cannot be probed.
		writeError(w, errNotFound)
		return
	}
	f, err := os.Open(s.mediaPath(a.ID))
	if err != nil {
		writeError(w, errNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("X-Content-Type-Options", "nosniff")
	if a.Kind == "public" {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "private, max-age=86400")
	}
	disposition := "attachment"
	contentType := "application/octet-stream"
	if inlineTypes[a.Mime] {
		disposition = "inline"
		contentType = a.Mime
	}
	h.Set("Content-Type", contentType)
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": a.Filename}))
	if h.Get("Content-Disposition") == "" {
		h.Set("Content-Disposition", fmt.Sprintf("%s; filename=\"file\"", disposition))
	}
	http.ServeContent(w, r, "", info.ModTime(), f)
}
