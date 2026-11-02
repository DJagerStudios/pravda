// Package store is Pravda's SQLite persistence layer.
//
// It deliberately knows nothing about permissions or realtime delivery: it
// stores and fetches. Those policies live in internal/server.
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"pravda/internal/id"
)

//go:embed schema.sql
var schemaV1 string

// migrations run in order; the database's user_version records progress.
var migrations = []string{schemaV1}

// Errors returned by the store.
var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("already exists")
	ErrGone     = errors.New("no longer valid")
)

// Store wraps a single-writer connection and a pool of readers. SQLite in WAL
// mode serves readers concurrently, but only ever one writer.
type Store struct {
	w, r *sql.DB
	IDs  id.Generator
}

// Open opens (creating if needed) the database at path and migrates it.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	pragmas := "_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(10000)"
	w, err := sql.Open("sqlite", "file:"+path+"?"+pragmas+"&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	r, err := sql.Open("sqlite", "file:"+path+"?"+pragmas+"&_pragma=query_only(1)")
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(8)
	s := &Store{w: w, r: r}
	if err := s.migrate(); err != nil {
		s.Close()
		return nil, fmt.Errorf("migrating database: %w", err)
	}
	return s, nil
}

// Close releases the database.
func (s *Store) Close() error {
	return errors.Join(s.r.Close(), s.w.Close())
}

func (s *Store) migrate() error {
	var version int
	if err := s.w.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	for ; version < len(migrations); version++ {
		tx, err := s.w.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[version]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", version+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", version+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

type rowScanner interface{ Scan(...any) error }

// queryRows runs a read query and scans each row with scan.
func queryRows[T any](ctx context.Context, db *sql.DB, scan func(rowScanner) (T, error), q string, args ...any) ([]T, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []T
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// placeholders returns "?,?,?" and the matching argument list.
func placeholders(ids []id.ID) (string, []any) {
	args := make([]any, len(ids))
	for i, v := range ids {
		args[i] = v
	}
	return strings.TrimSuffix(strings.Repeat("?,", len(ids)), ","), args
}

func now() int64 { return time.Now().UnixMilli() }

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func checkAffected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ExecForTest runs a raw statement. Tests use it to simulate the passage of
// time; nothing else should.
func (s *Store) ExecForTest(query string, args ...any) (sql.Result, error) {
	return s.w.Exec(query, args...)
}
