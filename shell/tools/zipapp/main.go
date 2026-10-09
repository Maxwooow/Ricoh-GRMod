// Command zipapp packs a macOS application bundle into a zip file that the
// Finder unpacks with the permissions intact (the executable stays
// executable), so the bundle can be built on a machine without macOS tools.
//
//	go run ./tools/zipapp -out dist/GRMod-mac.zip "dist/GR Mod.app"
//
// Entries are stored under the bundle's own name, directories first, in a
// stable order, with the file modes recorded as Unix attributes.
package main

import (
	"archive/zip"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func main() {
	out := flag.String("out", "", "zip file to write")
	flag.Parse()
	if *out == "" || flag.NArg() != 1 {
		log.Fatal("usage: zipapp -out FILE.zip BUNDLE.app")
	}
	bundle := filepath.Clean(flag.Arg(0))
	parent := filepath.Dir(bundle)

	var paths []string
	err := filepath.WalkDir(bundle, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%s: symbolic links are not supported", p)
		}
		paths = append(paths, p)
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
	sort.Strings(paths)

	f, err := os.Create(*out)
	if err != nil {
		log.Fatal(err)
	}
	zw := zip.NewWriter(f)
	stamp := time.Now().UTC().Truncate(time.Second)
	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil {
			log.Fatal(err)
		}
		rel, err := filepath.Rel(parent, p)
		if err != nil {
			log.Fatal(err)
		}
		name := filepath.ToSlash(rel)
		h := &zip.FileHeader{Name: name, Modified: stamp}
		if fi.IsDir() {
			h.Name = strings.TrimSuffix(name, "/") + "/"
			h.SetMode(fs.ModeDir | 0o755)
			if _, err := zw.CreateHeader(h); err != nil {
				log.Fatal(err)
			}
			continue
		}
		mode := fs.FileMode(0o644)
		if fi.Mode()&0o111 != 0 {
			mode = 0o755
		}
		h.SetMode(mode)
		h.Method = zip.Deflate
		w, err := zw.CreateHeader(h)
		if err != nil {
			log.Fatal(err)
		}
		src, err := os.Open(p)
		if err != nil {
			log.Fatal(err)
		}
		if _, err := io.Copy(w, src); err != nil {
			log.Fatal(err)
		}
		src.Close()
	}
	if err := zw.Close(); err != nil {
		log.Fatal(err)
	}
	if err := f.Close(); err != nil {
		log.Fatal(err)
	}
	fmt.Println("wrote", *out)
}
