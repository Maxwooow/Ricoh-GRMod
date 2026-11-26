//go:build windows || darwin || (linux && desktop)

package platform

import (
	"path/filepath"
	"strings"

	"github.com/ncruces/zenity"
)

// saveOptions are the save dialog's: the title, the file name it starts with,
// a filter for the name's extension (".cube": "*.cube") and a question before
// an existing file is replaced.
func saveOptions(title, name string) []zenity.Option {
	opts := []zenity.Option{zenity.Filename(filepath.Base(name)), zenity.ConfirmOverwrite()}
	if title != "" {
		opts = append(opts, zenity.Title(title))
	}
	if ext := filepath.Ext(name); ext != "" {
		opts = append(opts, zenity.FileFilter{Name: strings.ToUpper(strings.TrimPrefix(ext, ".")), Patterns: []string{"*" + ext}})
	}
	return opts
}
