// Package update keeps GR Mod up to date: it asks the release site which
// version is current, downloads the new program, checks it against a
// manifest signed with the project's Ed25519 key, and replaces the running
// program with it (the shell then starts the new one).
//
// What a release publishes, next to each other (for GitHub: assets of the
// release, reached through releases/latest/download/):
//
//	update.json       the manifest (see Manifest), exactly the bytes that were signed
//	update.json.sig   the Ed25519 signature of update.json, base64
//	GRMod-1.2.3.exe        Windows program
//	GRMod-1.2.3-mac.zip    macOS bundle, zipped by tools/zipapp
//
// Nothing is trusted that the signature does not cover: the program file is
// accepted only when its size and SHA-256 match the signed manifest, and the
// manifest only when the signature verifies with the public key compiled
// into the program. A mirror or an attacker in between can therefore at
// most withhold an update, not substitute one.
//
// The package is written for Go 1.20 (the macOS Intel build; see build.sh).
package update

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ManifestName and SignatureName are the file names of a release's manifest
// and its signature.
const (
	ManifestName  = "update.json"
	SignatureName = "update.json.sig"
	// AppName identifies GR Mod's manifests.
	AppName = "GRMod"
)

// Platform keys of Manifest.Files.
const (
	PlatformWindows = "windows-amd64"
	PlatformMac     = "darwin"
)

// Limits on what is downloaded.
const (
	maxManifest = 64 << 10
	maxPackage  = 300 << 20
)

// Manifest describes one release.
type Manifest struct {
	App     string `json:"app"`
	Version string `json:"version"`
	// Date is the release date, YYYY-MM-DD.
	Date string `json:"date,omitempty"`
	// Notes are short release notes per language ("zh", "en").
	Notes map[string]string `json:"notes,omitempty"`
	// Page is a web page for the release, shown when the update cannot be
	// installed automatically.
	Page  string          `json:"page,omitempty"`
	Files map[string]File `json:"files"`
}

// File is one program package of a release.
type File struct {
	// Name is the file name next to the manifest (no directories).
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Errors the caller tells apart.
var (
	ErrBadSignature = errors.New("the update's signature does not verify")
	ErrNoPackage    = errors.New("the release has no package for this system")
	ErrMismatch     = errors.New("the downloaded file does not match the signed manifest")
)

// ParseManifest checks the signature over data and decodes it.
func ParseManifest(data []byte, signature string, key ed25519.PublicKey) (*Manifest, error) {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil || len(sig) != ed25519.SignatureSize || len(key) != ed25519.PublicKeySize {
		return nil, ErrBadSignature
	}
	if !ed25519.Verify(key, data, sig) {
		return nil, ErrBadSignature
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("unreadable manifest: %w", err)
	}
	if m.App != AppName {
		return nil, fmt.Errorf("the manifest is not for %s", AppName)
	}
	if _, ok := parseVersion(m.Version); !ok {
		return nil, fmt.Errorf("the manifest has an unusable version %q", m.Version)
	}
	for k, f := range m.Files {
		if f.Name == "" || f.Name != filepath.Base(f.Name) || strings.ContainsAny(f.Name, `/\`) || f.Name == "." || f.Name == ".." {
			return nil, fmt.Errorf("the manifest has an unusable file name for %s", k)
		}
		if f.Size <= 0 || f.Size > maxPackage {
			return nil, fmt.Errorf("the manifest has an unusable size for %s", k)
		}
		if b, err := hex.DecodeString(f.SHA256); err != nil || len(b) != sha256.Size {
			return nil, fmt.Errorf("the manifest has an unusable SHA-256 for %s", k)
		}
	}
	return &m, nil
}

// Sign returns the base64 signature of data (used by tools/updatesign).
func Sign(data []byte, key ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, data))
}

// parseVersion splits "1.2.3" (optionally "v1.2.3") into numbers.
func parseVersion(v string) ([]int, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil, false
	}
	parts := strings.Split(v, ".")
	if len(parts) > 4 {
		return nil, false
	}
	out := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 99999 {
			return nil, false
		}
		out[i] = n
	}
	return out, true
}

// Newer reports whether version a is newer than b. Versions that cannot be
// parsed are never newer, and nothing is newer than an unparsable current
// version (a development build does not offer updates).
func Newer(a, b string) bool {
	x, ok1 := parseVersion(a)
	y, ok2 := parseVersion(b)
	if !ok1 || !ok2 {
		return false
	}
	for i := 0; i < len(x) || i < len(y); i++ {
		var p, q int
		if i < len(x) {
			p = x[i]
		}
		if i < len(y) {
			q = y[i]
		}
		if p != q {
			return p > q
		}
	}
	return false
}

// Info is the result of a check.
type Info struct {
	Current   string            `json:"current"`
	Latest    string            `json:"latest"`
	Available bool              `json:"available"`
	Date      string            `json:"date,omitempty"`
	Notes     map[string]string `json:"notes,omitempty"`
	Page      string            `json:"page,omitempty"`
	Size      int64             `json:"size"`
	// CanInstall is false when this copy of the program cannot replace
	// itself; Reason then says why (a code the UI translates).
	CanInstall bool   `json:"canInstall"`
	Reason     string `json:"reason,omitempty"`
	// Other is the newest release of a later line (see Updater.Below), which
	// this copy does not install: GR Mod for a later camera firmware.
	Other *OtherLine `json:"other,omitempty"`

	source   *url.URL
	manifest *Manifest
	file     File
}

// OtherLine is a release of a later line of GR Mod.
type OtherLine struct {
	Version string `json:"version"`
	Page    string `json:"page,omitempty"`
}

// Reasons for CanInstall == false.
const (
	ReasonNoPackage    = "no-package"   // the release has nothing for this system
	ReasonTranslocated = "translocated" // macOS runs the app from a temporary read-only copy
	ReasonReadOnly     = "read-only"    // the program's folder cannot be written
	ReasonUnsupported  = "unsupported"  // this build cannot replace itself
	ReasonManual       = "manual"       // the release has no signed manifest: download it by hand
)

// Updater checks for, downloads and installs updates.
type Updater struct {
	// Current is the running version.
	Current string
	// Sources are base addresses (ending in "/") where the release files
	// are found, tried in order.
	Sources []string
	// Key verifies the manifest.
	Key ed25519.PublicKey
	// Platform selects the package (PlatformWindows, PlatformMac).
	Platform string
	// HTTP is the client; nil selects http.DefaultClient.
	HTTP *http.Client
	// Target replaces the program; nil means updates can only be offered.
	Target Target
	// LatestPage is an address that redirects to the page of the newest
	// release, ending in /releases/tag/<version> (GitHub's releases/latest).
	// When no source has a manifest that verifies (a release published
	// without update.json, as 0.7.0 was), the version in that address still
	// says whether this copy is the newest; a newer one is then offered for
	// download by hand only. "" disables this.
	LatestPage string
	// Below, when set, ends this copy's line: a release of this version or
	// later belongs to a later line (GR Mod 0.8.x is for camera firmware
	// 1.11, a later GR Mod for 1.20) and is only reported (Info.Other), never
	// offered as this copy's update. Sources are then best ordered with this
	// line's own channel first.
	Below string
}

// ofLine reports whether version v belongs to this copy's line.
func (u *Updater) ofLine(v string) bool {
	return u.Below == "" || Newer(u.Below, v)
}

// Target is the program as installed on disk.
type Target interface {
	// Check returns "" when the program can be replaced, else a Reason.
	Check() string
	// Stage turns the verified download (a file in StageDir) into the
	// replacement, ready for Swap.
	Stage(download string) error
	// StageDir is a directory on the same volume as the program, for the
	// download.
	StageDir() string
	// Swap puts the staged replacement in place of the running program,
	// keeping the old one until Cleanup.
	Swap() error
	// Relaunch starts the (new) program with these arguments.
	Relaunch(args []string) error
	// Cleanup removes what an earlier update left behind.
	Cleanup()
}

func (u *Updater) client() *http.Client {
	if u.HTTP != nil {
		return u.HTTP
	}
	return http.DefaultClient
}

func (u *Updater) get(ctx context.Context, address string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GRMod/"+u.Current)
	req.Header.Set("Cache-Control", "no-cache")
	res, err := u.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", address, res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s: too large", address)
	}
	return data, nil
}

// Check asks the sources, in order, for the current release. The first
// source that answers with a manifest that verifies decides; a source that
// cannot be reached or answers with something that does not verify is
// skipped (the last error is returned when none works).
func (u *Updater) Check(ctx context.Context) (*Info, error) {
	in, other, err := u.check(ctx)
	if in == nil && other != nil {
		// Only releases of a later line: this copy is the newest of its own.
		in, err = &Info{Current: u.Current, Latest: u.Current, Reason: ReasonManual}, nil
	}
	if in != nil && u.Below != "" && other == nil && u.LatestPage != "" {
		// Is there a later line? (Its releases are the "latest" ones.)
		if version, page, e := u.latestRelease(ctx); e == nil && !u.ofLine(version) {
			other = &OtherLine{Version: version, Page: page}
		}
	}
	if in != nil {
		in.Other = other
	}
	return in, err
}

func (u *Updater) check(ctx context.Context) (*Info, *OtherLine, error) {
	var other *OtherLine
	note := func(version, page string) {
		if other == nil || Newer(version, other.Version) {
			other = &OtherLine{Version: version, Page: page}
		}
	}
	var last error = errors.New("no update source")
	for _, s := range u.Sources {
		base, err := url.Parse(s)
		if err != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") {
			last = fmt.Errorf("unusable update source %q", s)
			continue
		}
		if !strings.HasSuffix(base.Path, "/") {
			base.Path += "/"
		}
		data, err := u.get(ctx, base.ResolveReference(&url.URL{Path: ManifestName}).String(), maxManifest)
		if err != nil {
			last = err
			continue
		}
		sig, err := u.get(ctx, base.ResolveReference(&url.URL{Path: SignatureName}).String(), 1024)
		if err != nil {
			last = err
			continue
		}
		m, err := ParseManifest(data, string(sig), u.Key)
		if err != nil {
			last = err
			continue
		}
		if !u.ofLine(m.Version) {
			note(m.Version, m.Page)
			continue
		}
		return u.info(base, m), other, nil
	}
	if u.LatestPage != "" {
		version, page, err := u.latestRelease(ctx)
		if err == nil {
			if !u.ofLine(version) {
				note(version, page)
				return nil, other, last
			}
			in := &Info{Current: u.Current, Latest: version, Page: page, Reason: ReasonManual}
			in.Available = Newer(version, u.Current)
			return in, other, nil
		}
		if ctx.Err() == nil {
			last = fmt.Errorf("%v; latest release: %w", last, err)
		}
	}
	return nil, other, last
}

// latestRelease follows LatestPage to the page of the newest release and
// returns its version (from /releases/tag/<version>) and address. Nothing
// is downloaded from the release page itself.
func (u *Updater) latestRelease(ctx context.Context) (string, string, error) {
	var found *url.URL
	c := *u.client()
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if strings.Contains(req.URL.Path, "/releases/tag/") {
			found = req.URL
			return http.ErrUseLastResponse
		}
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, u.LatestPage, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", "GRMod/"+u.Current)
	req.Header.Set("Cache-Control", "no-cache")
	res, err := c.Do(req)
	if err != nil {
		return "", "", err
	}
	res.Body.Close()
	if found == nil {
		return "", "", fmt.Errorf("%s: no release found (%s)", u.LatestPage, res.Status)
	}
	tag, err := url.PathUnescape(found.Path[strings.LastIndex(found.Path, "/")+1:])
	if err != nil {
		return "", "", err
	}
	if _, ok := parseVersion(tag); !ok {
		return "", "", fmt.Errorf("the newest release has an unusable version %q", tag)
	}
	page := ""
	if found.Scheme == "https" {
		page = found.String()
	}
	return strings.TrimPrefix(strings.TrimSpace(tag), "v"), page, nil
}

func (u *Updater) info(base *url.URL, m *Manifest) *Info {
	in := &Info{Current: u.Current, Latest: m.Version, Date: m.Date, Notes: m.Notes, Page: m.Page, source: base, manifest: m}
	in.Available = Newer(m.Version, u.Current)
	f, ok := m.Files[u.Platform]
	switch {
	case !ok:
		in.Reason = ReasonNoPackage
	case u.Target == nil:
		in.Reason = ReasonUnsupported
	default:
		in.Reason = u.Target.Check()
	}
	in.file = f
	in.Size = f.Size
	in.CanInstall = in.Reason == ""
	return in
}

// Download fetches the package of in, checks it against the signed
// manifest and stages it. progress receives the bytes received so far.
func (u *Updater) Download(ctx context.Context, in *Info, progress func(received, total int64)) error {
	if in == nil || in.manifest == nil {
		return errors.New("no update to download")
	}
	if !in.CanInstall {
		return ErrNoPackage
	}
	f := in.file
	address := in.source.ResolveReference(&url.URL{Path: f.Name}).String()
	dir := u.Target.StageDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(name)
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "GRMod/"+u.Current)
	res, err := u.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", address, res.Status)
	}
	h := sha256.New()
	pr := &progressReader{r: io.LimitReader(res.Body, f.Size+1), total: f.Size, fn: progress}
	n, err := io.Copy(io.MultiWriter(tmp, h), pr)
	if err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if n != f.Size || hex.EncodeToString(h.Sum(nil)) != strings.ToLower(f.SHA256) {
		return ErrMismatch
	}
	if err := u.Target.Stage(name); err != nil {
		return err
	}
	ok = true
	os.Remove(name) // Stage has copied, renamed or unpacked it
	return nil
}

type progressReader struct {
	r        io.Reader
	n, total int64
	fn       func(int64, int64)
	last     time.Time
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.n += int64(n)
	if p.fn != nil && (err != nil || time.Since(p.last) > 100*time.Millisecond) {
		p.last = time.Now()
		p.fn(p.n, p.total)
	}
	return n, err
}
