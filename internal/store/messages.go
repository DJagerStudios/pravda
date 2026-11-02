package store

import (
	"context"
	"database/sql"
	"time"

	"pravda/internal/id"
)

// Attachment is an uploaded file. For messages and server icons the bytes are
// ciphertext and the real name and type travel inside the encrypted message.
type Attachment struct {
	ID         id.ID  `json:"id"`
	UploaderID id.ID  `json:"uploader_id"`
	MessageID  id.ID  `json:"message_id"`
	ServerID   id.ID  `json:"server_id,omitzero"`
	Kind       string `json:"kind"`
	Filename   string `json:"filename"`
	Mime       string `json:"mime"`
	Size       int64  `json:"size"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	CreatedAt  int64  `json:"created_at"`
}

// Reaction is one person's encrypted reaction to a message.
type Reaction struct {
	ID      id.ID  `json:"id"`
	UserID  id.ID  `json:"user_id"`
	Content string `json:"content"`
}

// ReplyPreview carries the quoted message, still encrypted.
type ReplyPreview struct {
	ID       id.ID  `json:"id"`
	AuthorID id.ID  `json:"author_id"`
	Content  string `json:"content"`
}

// Message is one post in a channel. Content is an encrypted envelope.
type Message struct {
	ID              id.ID         `json:"id"`
	ChannelID       id.ID         `json:"channel_id"`
	ServerID        id.ID         `json:"server_id,omitzero"`
	AuthorID        id.ID         `json:"author_id"`
	Author          *User         `json:"author,omitempty"`
	Kind            string        `json:"kind"`
	Content         string        `json:"content"`
	ReplyTo         id.ID         `json:"reply_to,omitzero"`
	Reply           *ReplyPreview `json:"reply,omitempty"`
	EditedAt        int64         `json:"edited_at,omitzero"`
	Pinned          bool          `json:"pinned,omitzero"`
	MentionEveryone bool          `json:"mention_everyone,omitzero"`
	ExpiresAt       int64         `json:"expires_at,omitzero"`
	Mentions        []id.ID       `json:"mentions,omitempty"`
	Attachments     []id.ID       `json:"attachments,omitempty"`
	Reactions       []Reaction    `json:"reactions,omitempty"`
}

const messageCols = `m.id, m.channel_id, c.server_id, m.author_id, m.kind, m.content, m.reply_to, m.edited_at, m.pinned, m.mention_everyone, m.expires_at`

func scanMessage(r rowScanner) (Message, error) {
	var m Message
	err := r.Scan(&m.ID, &m.ChannelID, &m.ServerID, &m.AuthorID, &m.Kind, &m.Content, &m.ReplyTo, &m.EditedAt, &m.Pinned,
		&m.MentionEveryone, &m.ExpiresAt)
	return m, err
}

// notExpired filters out messages whose time is up but which the janitor has
// not swept yet.
const notExpired = ` AND (m.expires_at = 0 OR m.expires_at > ?)`

// NewMessage holds what CreateMessage needs.
type NewMessage struct {
	ChannelID       id.ID
	AuthorID        id.ID
	Kind            string
	Content         string
	ReplyTo         id.ID
	Mentions        []id.ID
	MentionEveryone bool
	Attachments     []id.ID // must be the author's own unused uploads
	Notify          []id.ID // users whose mention counter goes up
	TTL             time.Duration
}

// CreateMessage posts a message and updates channel and read bookkeeping.
func (s *Store) CreateMessage(ctx context.Context, n NewMessage) (Message, error) {
	if n.Kind == "" {
		n.Kind = "default"
	}
	messageID := s.IDs.Next()
	var expires int64
	if n.TTL > 0 {
		expires = time.Now().Add(n.TTL).UnixMilli()
	}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if n.ReplyTo != 0 {
			var channel id.ID
			if err := tx.QueryRowContext(ctx, `SELECT channel_id FROM messages WHERE id = ?`, n.ReplyTo).Scan(&channel); err != nil || channel != n.ChannelID {
				n.ReplyTo = 0 // replying to something deleted or elsewhere: post it plainly
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO messages (id, channel_id, author_id, kind, content, reply_to, mention_everyone, expires_at)
			VALUES (?,?,?,?,?,?,?,?)`, messageID, n.ChannelID, n.AuthorID, n.Kind, n.Content, n.ReplyTo, n.MentionEveryone, expires); err != nil {
			return err
		}
		for _, user := range n.Mentions {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`, messageID, user); err != nil {
				return err
			}
		}
		for _, a := range n.Attachments {
			res, err := tx.ExecContext(ctx, `UPDATE attachments SET message_id = ? WHERE id = ? AND uploader_id = ? AND message_id = 0 AND kind = 'message'`,
				messageID, a, n.AuthorID)
			if err := checkAffected(res, err); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE channels SET last_message_id = ?, message_count = message_count + 1 WHERE id = ?`, messageID, n.ChannelID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO read_states (user_id, channel_id, last_read_id, mentions) VALUES (?,?,?,0)
			ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mentions = 0`, n.AuthorID, n.ChannelID, messageID); err != nil {
			return err
		}
		for _, user := range n.Notify {
			if _, err := tx.ExecContext(ctx, `INSERT INTO read_states (user_id, channel_id, mentions) VALUES (?,?,1)
				ON CONFLICT (user_id, channel_id) DO UPDATE SET mentions = mentions + 1`, user, n.ChannelID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Message{}, err
	}
	return s.getMessage(ctx, s.w, messageID)
}

// GetMessage fetches and fully hydrates one message.
func (s *Store) GetMessage(ctx context.Context, message id.ID) (Message, error) {
	return s.getMessage(ctx, s.r, message)
}

func (s *Store) getMessage(ctx context.Context, db *sql.DB, message id.ID) (Message, error) {
	m, err := scanMessage(db.QueryRowContext(ctx, `SELECT `+messageCols+` FROM messages m JOIN channels c ON c.id = m.channel_id
		WHERE m.id = ?`+notExpired, message, now()))
	if err != nil {
		return m, notFound(err)
	}
	list := []Message{m}
	if err := s.hydrate(ctx, db, list); err != nil {
		return m, err
	}
	return list[0], nil
}

// MessageQuery selects a page of a channel. Set at most one of Before, After
// and Around.
type MessageQuery struct {
	Channel id.ID
	Before  id.ID
	After   id.ID
	Around  id.ID
	Limit   int
}

// ListMessages returns a page, oldest first.
func (s *Store) ListMessages(ctx context.Context, q MessageQuery) ([]Message, error) {
	if q.Around != 0 {
		half := q.Limit / 2
		older, err := s.ListMessages(ctx, MessageQuery{Channel: q.Channel, Before: q.Around + 1, Limit: half + 1})
		if err != nil {
			return nil, err
		}
		newer, err := s.ListMessages(ctx, MessageQuery{Channel: q.Channel, After: q.Around, Limit: q.Limit - half})
		if err != nil {
			return nil, err
		}
		return append(older, newer...), nil
	}
	base := `SELECT ` + messageCols + ` FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.channel_id = ?` + notExpired
	var list []Message
	var err error
	t := now()
	switch {
	case q.After != 0:
		list, err = queryRows(ctx, s.r, scanMessage, base+` AND m.id > ? ORDER BY m.id ASC LIMIT ?`, q.Channel, t, q.After, q.Limit)
	case q.Before != 0:
		list, err = queryRows(ctx, s.r, scanMessage, base+` AND m.id < ? ORDER BY m.id DESC LIMIT ?`, q.Channel, t, q.Before, q.Limit)
		reverse(list)
	default:
		list, err = queryRows(ctx, s.r, scanMessage, base+` ORDER BY m.id DESC LIMIT ?`, q.Channel, t, q.Limit)
		reverse(list)
	}
	if err != nil {
		return nil, err
	}
	return list, s.hydrate(ctx, s.r, list)
}

func reverse(list []Message) {
	for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
		list[i], list[j] = list[j], list[i]
	}
}

// PinnedMessages returns a channel's pins, newest first.
func (s *Store) PinnedMessages(ctx context.Context, channel id.ID) ([]Message, error) {
	list, err := queryRows(ctx, s.r, scanMessage, `SELECT `+messageCols+` FROM messages m JOIN channels c ON c.id = m.channel_id
		WHERE m.channel_id = ? AND m.pinned = 1`+notExpired+` ORDER BY m.id DESC LIMIT 200`, channel, now())
	if err != nil {
		return nil, err
	}
	return list, s.hydrate(ctx, s.r, list)
}

// hydrate fills in authors, attachment IDs, reactions, mentions and quoted
// replies for a page of messages.
func (s *Store) hydrate(ctx context.Context, db *sql.DB, list []Message) error {
	if len(list) == 0 {
		return nil
	}
	ids := make([]id.ID, len(list))
	index := make(map[id.ID]*Message, len(list))
	authorSet := map[id.ID]bool{}
	var replyIDs []id.ID
	for i := range list {
		ids[i] = list[i].ID
		index[list[i].ID] = &list[i]
		authorSet[list[i].AuthorID] = true
		if list[i].ReplyTo != 0 {
			replyIDs = append(replyIDs, list[i].ReplyTo)
		}
	}
	ph, args := placeholders(ids)

	type pair struct{ message, other id.ID }
	scanPair := func(r rowScanner) (pair, error) {
		var p pair
		err := r.Scan(&p.message, &p.other)
		return p, err
	}
	attachments, err := queryRows(ctx, db, scanPair, `SELECT message_id, id FROM attachments WHERE message_id IN (`+ph+`) ORDER BY id`, args...)
	if err != nil {
		return err
	}
	for _, p := range attachments {
		if m := index[p.message]; m != nil {
			m.Attachments = append(m.Attachments, p.other)
		}
	}
	mentions, err := queryRows(ctx, db, scanPair, `SELECT message_id, user_id FROM message_mentions WHERE message_id IN (`+ph+`)`, args...)
	if err != nil {
		return err
	}
	for _, p := range mentions {
		if m := index[p.message]; m != nil {
			m.Mentions = append(m.Mentions, p.other)
		}
	}

	type react struct {
		message id.ID
		Reaction
	}
	reactions, err := queryRows(ctx, db, func(r rowScanner) (react, error) {
		var v react
		err := r.Scan(&v.message, &v.ID, &v.UserID, &v.Content)
		return v, err
	}, `SELECT message_id, id, user_id, content FROM reactions WHERE message_id IN (`+ph+`) ORDER BY id`, args...)
	if err != nil {
		return err
	}
	for _, v := range reactions {
		if m := index[v.message]; m != nil {
			m.Reactions = append(m.Reactions, v.Reaction)
		}
	}

	replies := map[id.ID]ReplyPreview{}
	if len(replyIDs) > 0 {
		rph, rargs := placeholders(replyIDs)
		previews, err := queryRows(ctx, db, func(r rowScanner) (ReplyPreview, error) {
			var v ReplyPreview
			err := r.Scan(&v.ID, &v.AuthorID, &v.Content)
			return v, err
		}, `SELECT id, author_id, content FROM messages WHERE id IN (`+rph+`)`, rargs...)
		if err != nil {
			return err
		}
		for _, p := range previews {
			replies[p.ID] = p
			authorSet[p.AuthorID] = true
		}
	}

	authorIDs := make([]id.ID, 0, len(authorSet))
	for a := range authorSet {
		authorIDs = append(authorIDs, a)
	}
	authors, err := s.UsersByID(ctx, authorIDs)
	if err != nil {
		return err
	}
	byID := make(map[id.ID]*User, len(authors))
	for i := range authors {
		byID[authors[i].ID] = &authors[i]
	}
	for i := range list {
		list[i].Author = byID[list[i].AuthorID]
		if p, ok := replies[list[i].ReplyTo]; ok {
			list[i].Reply = &p
		}
	}
	return nil
}

// EditMessage replaces a message's content and mentions.
func (s *Store) EditMessage(ctx context.Context, message id.ID, content string, mentions []id.ID, everyone bool) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := checkAffected(tx.ExecContext(ctx, `UPDATE messages SET content = ?, edited_at = ?, mention_everyone = ? WHERE id = ?`,
			content, now(), everyone, message)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM message_mentions WHERE message_id = ?`, message); err != nil {
			return err
		}
		for _, user := range mentions {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`, message, user); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteMessage removes a message. It returns the attachment IDs whose files
// must be removed from disk.
func (s *Store) DeleteMessage(ctx context.Context, channel, message id.ID) ([]id.ID, error) {
	var files []id.ID
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		if files, err = collectIDs(ctx, tx, `SELECT id FROM attachments WHERE message_id = ?`, message); err != nil {
			return err
		}
		if err := deleteAttachments(ctx, tx, files); err != nil {
			return err
		}
		if err := checkAffected(tx.ExecContext(ctx, `DELETE FROM messages WHERE id = ? AND channel_id = ?`, message, channel)); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE channels SET message_count = message_count - 1,
			last_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = ?1), 0) WHERE id = ?1`, channel)
		return err
	})
	return files, err
}

// Expired is a message whose time ran out.
type Expired struct {
	ID        id.ID
	ChannelID id.ID
}

// ClaimExpiredMessages deletes messages past their expiry. It returns them so
// clients can be told, and their attachments so the files can be removed.
func (s *Store) ClaimExpiredMessages(ctx context.Context) ([]Expired, []id.ID, error) {
	var gone []Expired
	var files []id.ID
	err := s.tx(ctx, func(tx *sql.Tx) error {
		cutoff := now()
		var err error
		if files, err = collectIDs(ctx, tx, `SELECT a.id FROM attachments a JOIN messages m ON a.message_id = m.id
			WHERE m.expires_at > 0 AND m.expires_at <= ?`, cutoff); err != nil {
			return err
		}
		if err := deleteAttachments(ctx, tx, files); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `DELETE FROM messages WHERE expires_at > 0 AND expires_at <= ? RETURNING id, channel_id`, cutoff)
		if err != nil {
			return err
		}
		for rows.Next() {
			var e Expired
			if err := rows.Scan(&e.ID, &e.ChannelID); err != nil {
				rows.Close()
				return err
			}
			gone = append(gone, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		touched := map[id.ID]bool{}
		for _, e := range gone {
			touched[e.ChannelID] = true
		}
		for channel := range touched {
			if _, err := tx.ExecContext(ctx, `UPDATE channels SET message_count = (SELECT COUNT(*) FROM messages WHERE channel_id = ?1),
				last_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = ?1), 0) WHERE id = ?1`, channel); err != nil {
				return err
			}
		}
		return nil
	})
	return gone, files, err
}

// SetPinned pins or unpins a message.
func (s *Store) SetPinned(ctx context.Context, channel, message id.ID, pinned bool) error {
	return checkAffected(s.w.ExecContext(ctx, `UPDATE messages SET pinned = ? WHERE id = ? AND channel_id = ?`, pinned, message, channel))
}

// ReactionCounts returns how many reactions a message has in total and from
// one user.
func (s *Store) ReactionCounts(ctx context.Context, message, user id.ID) (total, mine int, err error) {
	err = s.r.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(user_id = ?), 0) FROM reactions WHERE message_id = ?`, user, message).Scan(&total, &mine)
	return total, mine, err
}

// AddReaction stores an encrypted reaction.
func (s *Store) AddReaction(ctx context.Context, message, user id.ID, content string) (Reaction, error) {
	r := Reaction{ID: s.IDs.Next(), UserID: user, Content: content}
	_, err := s.w.ExecContext(ctx, `INSERT INTO reactions (id, message_id, user_id, content, created_at) VALUES (?,?,?,?,?)`,
		r.ID, message, user, content, now())
	return r, err
}

// GetReaction fetches one reaction with its message.
func (s *Store) GetReaction(ctx context.Context, reaction id.ID) (Reaction, id.ID, error) {
	var r Reaction
	var message id.ID
	err := s.r.QueryRowContext(ctx, `SELECT id, user_id, content, message_id FROM reactions WHERE id = ?`, reaction).Scan(&r.ID, &r.UserID, &r.Content, &message)
	return r, message, notFound(err)
}

// RemoveReaction deletes a reaction.
func (s *Store) RemoveReaction(ctx context.Context, reaction id.ID) error {
	return checkAffected(s.w.ExecContext(ctx, `DELETE FROM reactions WHERE id = ?`, reaction))
}

// ReadState tracks how far a user has read a channel.
type ReadState struct {
	ChannelID  id.ID `json:"channel_id"`
	LastReadID id.ID `json:"last_read_id"`
	Mentions   int   `json:"mentions"`
}

// ReadStates lists a user's read markers.
func (s *Store) ReadStates(ctx context.Context, user id.ID) ([]ReadState, error) {
	return queryRows(ctx, s.r, func(r rowScanner) (ReadState, error) {
		var v ReadState
		err := r.Scan(&v.ChannelID, &v.LastReadID, &v.Mentions)
		return v, err
	}, `SELECT channel_id, last_read_id, mentions FROM read_states WHERE user_id = ?`, user)
}

// MarkRead moves a read marker and clears mentions. Markers never move
// backwards.
func (s *Store) MarkRead(ctx context.Context, user, channel, message id.ID) (ReadState, error) {
	v := ReadState{ChannelID: channel}
	_, err := s.w.ExecContext(ctx, `INSERT INTO read_states (user_id, channel_id, last_read_id, mentions) VALUES (?,?,?,0)
		ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id), mentions = 0`, user, channel, message)
	if err != nil {
		return v, err
	}
	err = s.w.QueryRowContext(ctx, `SELECT last_read_id, mentions FROM read_states WHERE user_id = ? AND channel_id = ?`, user, channel).Scan(&v.LastReadID, &v.Mentions)
	return v, err
}

const attachmentCols = `id, uploader_id, message_id, server_id, kind, filename, mime, size, width, height, created_at`

func scanAttachment(r rowScanner) (Attachment, error) {
	var a Attachment
	err := r.Scan(&a.ID, &a.UploaderID, &a.MessageID, &a.ServerID, &a.Kind, &a.Filename, &a.Mime, &a.Size, &a.Width, &a.Height, &a.CreatedAt)
	return a, err
}

// CreateAttachment registers an uploaded file.
func (s *Store) CreateAttachment(ctx context.Context, a Attachment) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO attachments (id, uploader_id, server_id, kind, filename, mime, size, width, height, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, a.ID, a.UploaderID, a.ServerID, a.Kind, a.Filename, a.Mime, a.Size, a.Width, a.Height, a.CreatedAt)
	return err
}

// GetAttachment fetches an attachment.
func (s *Store) GetAttachment(ctx context.Context, attachment id.ID) (Attachment, error) {
	a, err := scanAttachment(s.r.QueryRowContext(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE id = ?`, attachment))
	return a, notFound(err)
}

// ClaimOrphanAttachments deletes message uploads that never reached a message
// and returns their IDs so the files can be removed.
func (s *Store) ClaimOrphanAttachments(ctx context.Context, olderThan time.Duration) ([]id.ID, error) {
	cutoff := time.Now().Add(-olderThan).UnixMilli()
	var files []id.ID
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		files, err = collectIDs(ctx, tx, `DELETE FROM attachments WHERE message_id = 0 AND kind = 'message' AND created_at < ? RETURNING id`, cutoff)
		return err
	})
	return files, err
}
