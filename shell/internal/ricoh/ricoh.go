// Package ricoh finds and downloads the current firmware update of a GR IV
// model from RICOH IMAGING's own download pages.
//
// The model's page, the version, the date and the file are read from the
// site every time, so a new release is shown as soon as Ricoh publishes it.
// The one thing hard-coded besides the site and its list page is what this
// program builds on, Supported and SupportedMono: releases that stay on the
// site at fixed addresses after newer ones replace them on the pages. Every
// request stays on the site's host.
package ricoh

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Site is RICOH IMAGING's web site.
const Site = "https://www.ricoh-imaging.co.jp"

// indexPath lists the firmware of every digital camera, one table row each.
const indexPath = "/english/support/download_digital.html"

// Limits. The GR IV update is a 34 MB archive holding one 38 MB file.
const (
	maxPageBytes     = 4 << 20
	maxArchiveBytes  = 160 << 20
	maxFirmwareBytes = 160 << 20
)

// Models maps the model keys of the interface to the names Ricoh uses.
var Models = map[string]string{
	"STANDARD": "GR IV",
	"HDF":      "GR IV HDF",
	"MONO":     "GR IV Monochrome",
}

// baseModel is the row that covers several variants of the camera.
const baseModel = "GR IV"

// ErrNoRelease means the site lists no firmware for the model.
var ErrNoRelease = errors.New("no firmware is listed for this model")

// ErrChecksum means a downloaded archive is not the one expected.
var ErrChecksum = errors.New("the archive is not the expected file")

// ErrUnknownModel is returned for a model key that is not in Models.
var ErrUnknownModel = errors.New("unknown model")

// Release is the firmware update currently offered for a model.
type Release struct {
	// Model is the key that was asked for.
	Model string `json:"model"`
	// Name is the row of the list the release was found in ("GR IV").
	Name string `json:"name"`
	// Applies is the page's own list of products ("RICOH GR IV / RICOH GR IV HDF").
	Applies string `json:"applies"`
	Version string `json:"version"`
	// Date is the release date as printed on the page ("2026/02/13"), or "".
	Date string `json:"date"`
	// Page is the address of the model's download page (with the licence).
	Page string `json:"page"`
	// File is the name of the archive ("gr4_v111.zip").
	File string `json:"file"`
	// Size is the size of the archive in bytes: exact when the server says
	// so, else the rounded figure printed on the page, 0 when neither.
	Size int64 `json:"size"`
	// URL is the address of the archive.
	URL string `json:"url"`
	// SHA256 is the expected SHA-256 of the archive (hex), "" when unknown.
	// Download refuses an archive that does not match.
	SHA256 string `json:"-"`
}

// Archive is a release that is no longer on the model's page but still on
// the site at a fixed address.
type Archive struct {
	Version string
	// Date is the release date as printed on the page.
	Date string
	// Path is the archive's address on the site.
	Path string
	// Size and SHA256 of the archive.
	Size   int64
	SHA256 string
	// Models are the model keys (see Models) the release is for.
	Models []string
	// Applies is the page's list of products for that release.
	Applies string
	// Page is the model's download page (with the licence), on the site.
	Page string
}

// Supported is the release this program builds on for the GR IV and GR IV
// HDF: 1.11 (2026/02/13). Checked 2026-10-21: still served at this address,
// whose archive holds the fwdc248b.bin with SHA-256 a2f664df…655f.
var Supported = Archive{
	Version: "1.11",
	Date:    "2026/02/13",
	Path:    "/resources/japan/support/download/digital/FIRMWARE/gr4_v111.zip",
	Size:    34478368,
	SHA256:  "ded47aa6385886e4b1f8f41f8551866ab0f1ecd0aef89934a43ef0e456539e8f",
	Models:  []string{"STANDARD", "HDF"},
	Applies: "RICOH GR IV / RICOH GR IV HDF",
	Page:    "/english/support/digital/gr4_s.html",
}

// SupportedMono is the release this program builds on for the GR IV
// Monochrome: 1.10 (2026/10/21), whose fwdc248b.bin (SHA-256 7563d7e4…650d) is
// also the one of GR IV 1.20. Checked 2026-10-21: served at this address,
// linked from the Monochrome's page.
var SupportedMono = Archive{
	Version: "1.10",
	Date:    "2026/10/21",
	Path:    "/resources/english/support/digital/FIRMWARE/gr4_mono_v110.zip",
	Size:    34702809,
	SHA256:  "bde05b3bf56a29c272284556d6795cb772eaccbbd0091d433fd52368d4d8af12",
	Models:  []string{"MONO"},
	Applies: "RICOH GR IV Monochrome",
	Page:    "/english/support/digital/gr-4-mono_s.html",
}

// supported are the releases this program builds on, at most one per model.
var supported = []*Archive{&Supported, &SupportedMono}

// Client talks to the site.
type Client struct {
	// Base replaces Site (tests).
	Base string
	// HTTP is the client to use; nil selects http.DefaultClient. Redirects
	// are followed by that client; the final address is checked here.
	HTTP *http.Client
	// Pinned replaces Supported and SupportedMono (tests): the one supported
	// release, for the models it names.
	Pinned *Archive
}

// pinned is the supported release for a model, or nil.
func (c *Client) pinned(model string) *Archive {
	list := supported
	if c.Pinned != nil {
		list = []*Archive{c.Pinned}
	}
	for _, a := range list {
		for _, m := range a.Models {
			if m == model {
				return a
			}
		}
	}
	return nil
}

func (c *Client) base() (*url.URL, error) {
	b := c.Base
	if b == "" {
		b = Site
	}
	u, err := url.Parse(b)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("unusable site address %q", b)
	}
	return u, nil
}

func (c *Client) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// resolve turns a link found on page `from` into an address on the same site.
func resolve(base, from *url.URL, href string) (*url.URL, error) {
	ref, err := url.Parse(strings.TrimSpace(href))
	if err != nil {
		return nil, fmt.Errorf("unusable link %q", href)
	}
	u := from.ResolveReference(ref)
	u.Fragment = ""
	if u.Scheme != base.Scheme || !strings.EqualFold(u.Host, base.Host) {
		return nil, fmt.Errorf("link leaves the site: %s", u)
	}
	return u, nil
}

func (c *Client) get(ctx context.Context, base, u *url.URL) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GRMod")
	res, err := c.client().Do(req)
	if err != nil {
		return nil, err
	}
	final := res.Request.URL
	if final.Scheme != base.Scheme || !strings.EqualFold(final.Host, base.Host) {
		res.Body.Close()
		return nil, fmt.Errorf("redirected away from the site: %s", final)
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("%s: %s", u, res.Status)
	}
	return res, nil
}

func (c *Client) page(ctx context.Context, base, u *url.URL) (string, error) {
	res, err := c.get(ctx, base, u)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxPageBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxPageBytes {
		return "", fmt.Errorf("%s: page is too large", u)
	}
	return string(data), nil
}

var (
	reRow        = regexp.MustCompile(`(?is)<tr\b[^>]*>(.*?)</tr>`)
	reCell       = regexp.MustCompile(`(?is)<t[dh]\b[^>]*>(.*?)</t[dh]>`)
	reTag        = regexp.MustCompile(`(?s)<[^>]*>`)
	reHref       = regexp.MustCompile(`(?is)<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']`)
	reVersion    = regexp.MustCompile(`^\d{1,2}\.\d{1,3}$`)
	reDate       = regexp.MustCompile(`\d{4}/\d{1,2}/\d{1,2}`)
	reSpace      = regexp.MustCompile(`[\s\x{00a0}\x{3000}]+`)
	reComment    = regexp.MustCompile(`(?s)<!--.*?-->`)
	reRangeTotal = regexp.MustCompile(`^bytes \d+-\d+/(\d+)$`)
	reKilobytes  = regexp.MustCompile(`(?i)([0-9][0-9,]*)\s*KB\b`)
)

// text is the visible text of an HTML fragment on one line.
func text(fragment string) string {
	return strings.TrimSpace(reSpace.ReplaceAllString(html.UnescapeString(reTag.ReplaceAllString(fragment, " ")), " "))
}

type row struct {
	cells []string // visible text of each cell
	href  string   // first link in the row
}

func rows(page string) []row {
	page = reComment.ReplaceAllString(page, "")
	var out []row
	for _, m := range reRow.FindAllStringSubmatch(page, -1) {
		var r row
		for _, c := range reCell.FindAllStringSubmatch(m[1], -1) {
			r.cells = append(r.cells, text(c[1]))
		}
		if h := reHref.FindStringSubmatch(m[1]); h != nil {
			r.href = html.UnescapeString(h[1])
		}
		if len(r.cells) > 0 {
			out = append(out, r)
		}
	}
	return out
}

// names reports whether the first cell of a row of the list names the model:
// "GR IV", or one of a list such as "GR IV / GR IV HDF" (the list page since
// 2026-10-21).
func names(cell, name string) bool {
	if strings.EqualFold(cell, name) {
		return true
	}
	for _, part := range strings.Split(cell, "/") {
		if strings.EqualFold(strings.TrimSpace(part), name) {
			return true
		}
	}
	return false
}

// indexEntry finds the row of the list whose first cell names `name`.
func indexEntry(list []row, name string) (href, version string, ok bool) {
	for _, r := range list {
		if !names(r.cells[0], name) || r.href == "" {
			continue
		}
		for i := len(r.cells) - 1; i >= 1; i-- {
			if reVersion.MatchString(r.cells[i]) {
				return r.href, r.cells[i], true
			}
		}
	}
	return "", "", false
}

// field returns the value next to a label in the page's two-column tables.
func field(list []row, label string) string {
	for _, r := range list {
		if len(r.cells) >= 2 && strings.EqualFold(r.cells[0], label) {
			return r.cells[1]
		}
	}
	return ""
}

// appliesTo reports whether a product list such as "RICOH GR IV / RICOH GR
// IV HDF" names the model.
func appliesTo(applies, name string) bool {
	for _, part := range strings.FieldsFunc(applies, func(r rune) bool { return r == '/' || r == ',' || r == '、' || r == ';' }) {
		p := strings.TrimSpace(part)
		if len(p) > 6 && strings.EqualFold(p[:6], "RICOH ") {
			p = strings.TrimSpace(p[6:])
		}
		if strings.EqualFold(p, name) {
			return true
		}
	}
	return false
}

// archiveLink is the first link of the page to a .zip file.
func archiveLink(page string) string {
	for _, m := range reHref.FindAllStringSubmatch(reComment.ReplaceAllString(page, ""), -1) {
		h := html.UnescapeString(m[1])
		if u, err := url.Parse(h); err == nil && strings.HasSuffix(strings.ToLower(u.Path), ".zip") {
			return h
		}
	}
	return ""
}

// Latest reads which firmware the site currently offers for a model.
func (c *Client) Latest(ctx context.Context, model string) (*Release, error) {
	name, ok := Models[model]
	if !ok {
		return nil, ErrUnknownModel
	}
	base, err := c.base()
	if err != nil {
		return nil, err
	}
	indexURL := base.ResolveReference(&url.URL{Path: indexPath})
	index, err := c.page(ctx, base, indexURL)
	if err != nil {
		return nil, err
	}
	list := rows(index)
	// A row of its own for the model, else the row of the base model when
	// that release says it also applies to this one.
	candidates := []string{name}
	if name != baseModel {
		candidates = append(candidates, baseModel)
	}
	for _, rowName := range candidates {
		href, version, ok := indexEntry(list, rowName)
		if !ok {
			continue
		}
		pageURL, err := resolve(base, indexURL, href)
		if err != nil {
			return nil, err
		}
		body, err := c.page(ctx, base, pageURL)
		if err != nil {
			return nil, err
		}
		fields := rows(body)
		applies := field(fields, "Applied product")
		if rowName != name && !appliesTo(applies, name) {
			continue
		}
		link := archiveLink(body)
		if link == "" {
			return nil, fmt.Errorf("%s: no download link found", pageURL)
		}
		fileURL, err := resolve(base, pageURL, link)
		if err != nil {
			return nil, err
		}
		rel := &Release{
			Model: model, Name: rowName, Applies: applies, Version: version,
			Date: reDate.FindString(field(fields, "Release date")),
			Page: pageURL.String(), File: path.Base(fileURL.Path), URL: fileURL.String(),
		}
		if rel.Size = c.size(ctx, base, fileURL); rel.Size == 0 {
			rel.Size = statedSize(field(fields, "Registered name"))
		}
		return rel, nil
	}
	return nil, ErrNoRelease
}

// Fallback is the supported release for a model when the site offers
// another version, or offers nothing (latest == nil); nil when the model is
// not one the supported release is for, or when latest is that release.
func (c *Client) Fallback(model string, latest *Release) (*Release, error) {
	a := c.pinned(model)
	if a == nil || (latest != nil && latest.Version == a.Version) {
		return nil, nil
	}
	base, err := c.base()
	if err != nil {
		return nil, err
	}
	fileURL := base.ResolveReference(&url.URL{Path: a.Path})
	page := base.ResolveReference(&url.URL{Path: a.Page}).String()
	// the row of the list: the base model's, or the model's own for a release of one model
	name := baseModel
	if len(a.Models) == 1 {
		name = Models[a.Models[0]]
	}
	if latest != nil {
		page = latest.Page
	}
	return &Release{
		Model: model, Name: name, Applies: a.Applies, Version: a.Version, Date: a.Date,
		Page: page, File: path.Base(a.Path), Size: a.Size, URL: fileURL.String(), SHA256: a.SHA256,
	}, nil
}

// size finds out how large the archive is without fetching it: from the
// answer to a HEAD request or, where that carries no length (the site's
// content network leaves it out), from a request for the first byte only.
// 0 when the site tells neither way.
func (c *Client) size(ctx context.Context, base, u *url.URL) int64 {
	ask := func(method, byteRange string) *http.Response {
		req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
		if err != nil {
			return nil
		}
		req.Header.Set("User-Agent", "GRMod")
		if byteRange != "" {
			req.Header.Set("Range", byteRange)
		}
		res, err := c.client().Do(req)
		if err != nil {
			return nil
		}
		res.Body.Close()
		if !strings.EqualFold(res.Request.URL.Host, base.Host) {
			return nil
		}
		return res
	}
	if res := ask(http.MethodHead, ""); res != nil && res.StatusCode == http.StatusOK && res.ContentLength > 0 {
		return res.ContentLength
	}
	if res := ask(http.MethodGet, "bytes=0-0"); res != nil && res.StatusCode == http.StatusPartialContent {
		if m := reRangeTotal.FindStringSubmatch(res.Header.Get("Content-Range")); m != nil {
			if n, err := strconv.ParseInt(m[1], 10, 64); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

// statedSize reads the size the page prints next to the file name, such as
// "Gr4_v111.zip (zip type file 33,671KB)". It is a rounded figure.
func statedSize(registered string) int64 {
	m := reKilobytes.FindStringSubmatch(registered)
	if m == nil {
		return 0
	}
	n, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64)
	if err != nil || n <= 0 || n > maxArchiveBytes/1024 {
		return 0
	}
	return n * 1024
}

// Download fetches the archive of a release and returns the firmware file it
// holds. progress, when not nil, is called as the bytes arrive (total is 0
// when the site does not announce a length).
func (c *Client) Download(ctx context.Context, rel *Release, progress func(received, total int64)) (name string, data []byte, err error) {
	base, err := c.base()
	if err != nil {
		return "", nil, err
	}
	u, err := url.Parse(rel.URL)
	if err != nil || u.Scheme != base.Scheme || !strings.EqualFold(u.Host, base.Host) {
		return "", nil, fmt.Errorf("download address is not on the site: %s", rel.URL)
	}
	res, err := c.get(ctx, base, u)
	if err != nil {
		return "", nil, err
	}
	defer res.Body.Close()
	total := res.ContentLength
	if total > maxArchiveBytes {
		return "", nil, fmt.Errorf("archive is too large (%d bytes)", total)
	}
	if total < 0 {
		total = 0
	}
	var buf bytes.Buffer
	if total > 0 {
		buf.Grow(int(total))
	}
	chunk := make([]byte, 256<<10)
	var received int64
	for {
		n, rerr := res.Body.Read(chunk)
		if n > 0 {
			received += int64(n)
			if received > maxArchiveBytes {
				return "", nil, errors.New("archive is too large")
			}
			buf.Write(chunk[:n])
			if progress != nil {
				progress(received, total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", nil, rerr
		}
	}
	if total > 0 && received != total {
		return "", nil, fmt.Errorf("download ended after %d of %d bytes", received, total)
	}
	if rel.SHA256 != "" {
		sum := sha256.Sum256(buf.Bytes())
		if !strings.EqualFold(hex.EncodeToString(sum[:]), rel.SHA256) {
			return "", nil, ErrChecksum
		}
	}
	return Unpack(buf.Bytes())
}

// firmwareName matches the update file of a Ricoh/Pentax camera, the name
// the camera itself looks for on the card: fwdc248b.bin.
var firmwareName = regexp.MustCompile(`(?i)^fwdc[0-9a-z]{2,8}\.bin$`)

// Unpack returns the single firmware file of an update archive.
func Unpack(archive []byte) (name string, data []byte, err error) {
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return "", nil, fmt.Errorf("not a zip archive: %w", err)
	}
	var found *zip.File
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !firmwareName.MatchString(path.Base(strings.ReplaceAll(f.Name, `\`, "/"))) {
			continue
		}
		if found != nil {
			return "", nil, errors.New("the archive holds more than one firmware file")
		}
		found = f
	}
	if found == nil {
		return "", nil, errors.New("the archive holds no firmware file")
	}
	if found.UncompressedSize64 == 0 || found.UncompressedSize64 > maxFirmwareBytes {
		return "", nil, fmt.Errorf("firmware file has an unusable size (%d bytes)", found.UncompressedSize64)
	}
	rc, err := found.Open()
	if err != nil {
		return "", nil, err
	}
	defer rc.Close()
	data, err = io.ReadAll(io.LimitReader(rc, maxFirmwareBytes+1))
	if err != nil {
		return "", nil, fmt.Errorf("the archive is damaged: %w", err)
	}
	if uint64(len(data)) != found.UncompressedSize64 {
		return "", nil, errors.New("the archive is damaged")
	}
	return path.Base(strings.ReplaceAll(found.Name, `\`, "/")), data, nil
}
