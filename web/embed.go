// Package web embeds the browser client into the server binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:public
var files embed.FS

// Files returns the client's static files.
func Files() fs.FS {
	sub, err := fs.Sub(files, "public")
	if err != nil {
		panic(err) // the embedded directory always exists
	}
	return sub
}
