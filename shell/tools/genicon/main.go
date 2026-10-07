// Command genicon draws the application icon: a dark rounded square with
// the letters "GR" and a screwdriver lying diagonally across them. It is an
// original drawing made of geometric shapes; the letters are plain strokes
// (lines and arcs) drawn here, no font, logo or brand mark is involved.
//
// Every size is rendered directly from the shapes (not scaled down from a
// big bitmap), with bolder proportions for the small sizes so that the
// 16-pixel icon stays legible.
//
//	go run ./tools/genicon -out winres
//
// writes icon16.png, icon32.png, icon48.png and icon256.png, which
// winres/winres.json turns into the icon resource of the executable. With
// -preview FILE it also writes a contact sheet of all sizes.
package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

type rgb struct{ r, g, b float64 }

var (
	bgTop      = rgb{0x2c, 0x30, 0x3a}
	bgBottom   = rgb{0x15, 0x17, 0x1c}
	rim        = rgb{0x4a, 0x50, 0x5e}
	light      = rgb{0xee, 0xe9, 0xdd}
	accent     = rgb{0xf0, 0x8a, 0x3c}
	accentDark = rgb{0xc9, 0x64, 0x1f}
	accentHi   = rgb{0xf8, 0xae, 0x6c}
	steel      = rgb{0xd3, 0xd8, 0xe0}
	steelDark  = rgb{0x8b, 0x93, 0xa1}
)

type pt struct{ x, y float64 }

// sdRoundRect is the signed distance from (x, y) to a rounded rectangle
// centred at (cx, cy) with half extents (hw, hh) and corner radius r;
// negative inside.
func sdRoundRect(x, y, cx, cy, hw, hh, r float64) float64 {
	qx := math.Abs(x-cx) - hw + r
	qy := math.Abs(y-cy) - hh + r
	outside := math.Hypot(math.Max(qx, 0), math.Max(qy, 0))
	inside := math.Min(math.Max(qx, qy), 0)
	return outside + inside - r
}

// distSegment is the distance from p to the segment a-b.
func distSegment(p, a, b pt) float64 {
	dx, dy := b.x-a.x, b.y-a.y
	l2 := dx*dx + dy*dy
	t := 0.0
	if l2 > 0 {
		t = ((p.x-a.x)*dx + (p.y-a.y)*dy) / l2
		t = math.Max(0, math.Min(1, t))
	}
	return math.Hypot(p.x-(a.x+t*dx), p.y-(a.y+t*dy))
}

// distArc is the distance from p to the circular arc around c with radius r
// that runs counter-clockwise (as seen on screen) from angle a0 to a1, in
// degrees, 0 = right, 90 = up.
func distArc(p, c pt, r, a0, a1 float64) float64 {
	ang := math.Atan2(-(p.y-c.y), p.x-c.x) * 180 / math.Pi
	rel := math.Mod(ang-a0+720, 360)
	if rel <= a1-a0 {
		return math.Abs(math.Hypot(p.x-c.x, p.y-c.y) - r)
	}
	end := func(a float64) pt {
		return pt{c.x + r*math.Cos(a*math.Pi/180), c.y - r*math.Sin(a*math.Pi/180)}
	}
	e0, e1 := end(a0), end(a1)
	return math.Min(math.Hypot(p.x-e0.x, p.y-e0.y), math.Hypot(p.x-e1.x, p.y-e1.y))
}

// design holds the proportions of one rendition, in units of the icon size.
type design struct {
	margin float64 // transparent border around the background
	corner float64 // corner radius of the background
	edge   float64 // width of the lighter rim of the background

	// Letters: centre lines, drawn with round-ended strokes.
	stroke float64 // line width of the letters
	top    float64 // y of the top centre line
	bottom float64 // y of the bottom centre line
	gx     float64 // x of the centre of the G
	gr     float64 // radius of the G (horizontal half width)
	gOpen  float64 // angle at which the G ends, degrees above the bar
	rx     float64 // x of the stem of the R
	rBowl  float64 // length of the straight part of the bowl
	rLeg   float64 // x of the foot of the leg

	// Screwdriver: from the end of the handle to the tip.
	from, to pt
	handle   float64 // share of the length taken by the handle
	handleW  float64 // half width of the handle
	ferrule  float64 // share of the length taken by the collar; 0 = none
	shaftW   float64 // half width of the shaft
	tip      float64 // share of the length taken by the blade
	tipW     float64 // half width of the blade
	halo     float64 // dark gap kept around the screwdriver
	detail   bool    // highlight and collar shading on the handle
}

// designFor picks the drawing for a size.
func designFor(size int) design {
	switch {
	case size <= 20:
		// 16 px: two-pixel strokes, a plain two-tone screwdriver that only
		// touches the feet of the letters.
		return design{corner: 0.2, edge: 1.0 / 16,
			stroke: 1.6 / 16, top: 3.6 / 16, bottom: 10.0 / 16, gx: 4.7 / 16, gr: 2.9 / 16, gOpen: 52, rx: 9.7 / 16, rBowl: 1.3 / 16, rLeg: 13.5 / 16,
			from: pt{1.8 / 16, 14.1 / 16}, to: pt{14.4 / 16, 9.6 / 16}, handle: 0.42, handleW: 1.2 / 16, shaftW: 0.6 / 16, tip: 0.12, tipW: 0.9 / 16, halo: 0.6 / 16}
	case size <= 40:
		return design{corner: 0.21, edge: 1.0 / 32,
			stroke: 3.3 / 32, top: 9.2 / 32, bottom: 21.8 / 32, gx: 9.7 / 32, gr: 5.8 / 32, gOpen: 38, rx: 19.5 / 32, rBowl: 3.1 / 32, rLeg: 27.2 / 32,
			from: pt{3.2 / 32, 27.6 / 32}, to: pt{29.6 / 32, 13.6 / 32}, handle: 0.40, handleW: 2.2 / 32, ferrule: 0.06, shaftW: 0.95 / 32, tip: 0.11, tipW: 1.6 / 32, halo: 1.1 / 32}
	case size <= 64:
		return design{corner: 0.215, edge: 1.0 / 48,
			stroke: 4.4 / 48, top: 14.2 / 48, bottom: 32.8 / 48, gx: 14.6 / 48, gr: 8.6 / 48, gOpen: 38, rx: 29.2 / 48, rBowl: 4.7 / 48, rLeg: 40.6 / 48,
			from: pt{4.8 / 48, 41.2 / 48}, to: pt{44.4 / 48, 20.4 / 48}, handle: 0.40, handleW: 3.2 / 48, ferrule: 0.06, shaftW: 1.3 / 48, tip: 0.11, tipW: 2.3 / 48, halo: 1.5 / 48, detail: true}
	default:
		return design{margin: 0.03, corner: 0.22, edge: 0.008,
			stroke: 0.086, top: 0.298, bottom: 0.684, gx: 0.305, gr: 0.178, gOpen: 38, rx: 0.607, rBowl: 0.098, rLeg: 0.842,
			from: pt{0.10, 0.858}, to: pt{0.925, 0.428}, handle: 0.40, handleW: 0.064, ferrule: 0.055, shaftW: 0.024, tip: 0.105, tipW: 0.046, halo: 0.026, detail: true}
	}
}

// letters returns the distance from p to the centre lines of "GR".
func (d design) letters(p pt) float64 {
	cy := (d.top + d.bottom) / 2
	ry := (d.bottom - d.top) / 2
	// G: an ellipse-like bowl built from a circle stretched vertically.
	// Work in a space where the bowl is a circle of radius gr.
	k := d.gr / ry
	q := pt{p.x, cy + (p.y-cy)*k}
	c := pt{d.gx, cy}
	g := distArc(q, c, d.gr, d.gOpen, 360)
	g = math.Min(g, distSegment(q, pt{d.gx + d.gr, cy}, pt{d.gx + 0.12*d.gr, cy}))
	// distances were measured in the squeezed space; undo it roughly along y
	if k < 1 {
		g /= (1 + k) / 2
	}

	// R: stem, bowl (two bars and a half circle), leg.
	br := ry * 0.52 // bowl radius: the bowl takes a little more than the upper half
	mid := d.top + 2*br
	r := distSegment(p, pt{d.rx, d.top}, pt{d.rx, d.bottom})
	r = math.Min(r, distSegment(p, pt{d.rx, d.top}, pt{d.rx + d.rBowl, d.top}))
	r = math.Min(r, distSegment(p, pt{d.rx, mid}, pt{d.rx + d.rBowl, mid}))
	r = math.Min(r, distArc(p, pt{d.rx + d.rBowl, d.top + br}, br, -90, 90))
	r = math.Min(r, distSegment(p, pt{d.rx + d.rBowl*0.75, mid}, pt{d.rLeg, d.bottom}))
	return math.Min(g, r)
}

// part identifies what the screwdriver shows at a point.
type part int

const (
	none part = iota
	handleBody
	handleHi
	handleCollar
	ferrulePart
	shaftPart
	shaftHi
	bladePart
)

// screwdriver returns the signed distance to the outline of the tool
// (negative inside) and the part under the point.
func (d design) screwdriver(p pt) (float64, part) {
	ax, ay := d.to.x-d.from.x, d.to.y-d.from.y
	l := math.Hypot(ax, ay)
	ux, uy := ax/l, ay/l
	u := ((p.x-d.from.x)*ux + (p.y-d.from.y)*uy) / l // 0..1 along the tool
	v := -(p.x-d.from.x)*uy + (p.y-d.from.y)*ux      // across, in icon units; negative = upper side

	hEnd := d.handle
	fEnd := hEnd + d.ferrule
	bStart := 1 - d.tip
	local := pt{u * l, v}

	// handle: a capsule that narrows into the collar at its front end
	hw := d.handleW
	dist := distSegment(local, pt{hw, 0}, pt{hEnd*l - hw*0.55, 0}) - hw
	which := handleBody
	if dist <= 0 {
		front := (hEnd*l - local.x) / (hw * 1.5)
		switch {
		case d.detail && front < 1:
			which = handleCollar
		case d.detail && v < -hw*0.28 && v > -hw*0.62 && local.x > hw*0.9:
			which = handleHi
		}
	}
	// collar between handle and shaft
	if d.ferrule > 0 {
		fd := sdRoundRect(local.x, local.y, (hEnd+d.ferrule/2)*l, 0, d.ferrule*l/2+d.shaftW*0.4, d.shaftW*1.75, d.shaftW*0.5)
		if fd < dist {
			dist, which = fd, ferrulePart
		}
	}
	// shaft
	sd := sdRoundRect(local.x, local.y, (fEnd+bStart)/2*l, 0, (bStart-fEnd)/2*l+d.shaftW, d.shaftW, 0)
	if sd < dist {
		dist, which = sd, shaftPart
		if d.detail && v < -d.shaftW*0.2 {
			which = shaftHi
		}
	}
	// blade: flares out from the shaft, then ends square
	if u >= bStart-0.02 {
		t := (u - bStart) / d.tip
		w := d.tipW
		if t < 0.45 {
			w = d.shaftW + (d.tipW-d.shaftW)*math.Max(0, t)/0.45
		}
		bd := math.Max(math.Abs(v)-w, local.x-l)
		if bd < dist {
			dist, which = bd, bladePart
		}
	}
	if dist > 0 {
		which = none
	}
	return dist, which
}

// sample returns the colour and opacity of the drawing at a point of the
// unit square.
func (d design) sample(x, y float64) (rgb, float64) {
	bg := sdRoundRect(x, y, 0.5, 0.5, 0.5-d.margin, 0.5-d.margin, d.corner)
	if bg > 0 {
		return rgb{}, 0
	}
	p := pt{x, y}
	background := func() rgb {
		t := (y - d.margin) / (1 - 2*d.margin)
		return rgb{
			bgTop.r + (bgBottom.r-bgTop.r)*t,
			bgTop.g + (bgBottom.g-bgTop.g)*t,
			bgTop.b + (bgBottom.b-bgTop.b)*t,
		}
	}
	// A slightly lighter rim keeps the shape visible on a dark taskbar.
	if bg > -d.edge {
		return rim, 1
	}
	dist, which := d.screwdriver(p)
	switch which {
	case handleBody:
		return accent, 1
	case handleHi:
		return accentHi, 1
	case handleCollar:
		return accentDark, 1
	case ferrulePart:
		return steelDark, 1
	case shaftPart:
		return steelDark, 1
	case shaftHi:
		return steel, 1
	case bladePart:
		return steel, 1
	}
	// the tool lies on top of the letters: keep a dark gap around it
	if dist <= d.halo {
		return background(), 1
	}
	if d.letters(p) <= d.stroke/2 {
		return light, 1
	}
	return background(), 1
}

// render draws the icon at the given size with 8x8 supersampling.
func render(size int) *image.NRGBA {
	const ss = 8
	d := designFor(size)
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					x := (float64(px) + (float64(sx)+0.5)/ss) / float64(size)
					y := (float64(py) + (float64(sy)+0.5)/ss) / float64(size)
					c, alpha := d.sample(x, y)
					r += c.r * alpha
					g += c.g * alpha
					b += c.b * alpha
					a += alpha
				}
			}
			if a == 0 {
				continue
			}
			img.SetNRGBA(px, py, color.NRGBA{
				R: uint8(math.Round(r / a)),
				G: uint8(math.Round(g / a)),
				B: uint8(math.Round(b / a)),
				A: uint8(math.Round(a / (ss * ss) * 255)),
			})
		}
	}
	return img
}

// contactSheet shows every size at its natural size and enlarged, on a
// light and on a dark strip, for checking legibility.
func contactSheet(icons map[int]*image.NRGBA, sizes []int) *image.NRGBA {
	const zoom = 256
	w := len(sizes)*(zoom+24) + 24
	h := 2 * (zoom + 300)
	sheet := image.NewNRGBA(image.Rect(0, 0, w, h))
	for row, bg := range []color.NRGBA{{0xf3, 0xf3, 0xf3, 0xff}, {0x20, 0x20, 0x20, 0xff}} {
		y0 := row * (zoom + 300)
		draw.Draw(sheet, image.Rect(0, y0, w, y0+zoom+300), &image.Uniform{bg}, image.Point{}, draw.Src)
		for i, size := range sizes {
			src := icons[size]
			x0 := 24 + i*(zoom+24)
			// enlarged with nearest neighbour
			for y := 0; y < zoom; y++ {
				for x := 0; x < zoom; x++ {
					c := src.NRGBAAt(x*size/zoom, y*size/zoom)
					if c.A == 0 {
						continue
					}
					a := float64(c.A) / 255
					o := sheet.NRGBAAt(x0+x, y0+16+y)
					sheet.SetNRGBA(x0+x, y0+16+y, color.NRGBA{
						uint8(float64(c.R)*a + float64(o.R)*(1-a)), uint8(float64(c.G)*a + float64(o.G)*(1-a)), uint8(float64(c.B)*a + float64(o.B)*(1-a)), 0xff})
				}
			}
			draw.Draw(sheet, image.Rect(x0, y0+zoom+28, x0+size, y0+zoom+28+size), src, image.Point{}, draw.Over)
		}
	}
	return sheet
}

func writePNG(name string, img image.Image) {
	f, err := os.Create(name)
	if err != nil {
		log.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		log.Fatal(err)
	}
	if err := f.Close(); err != nil {
		log.Fatal(err)
	}
	fmt.Println("wrote", name)
}

func main() {
	out := flag.String("out", "winres", "output directory")
	preview := flag.String("preview", "", "also write a contact sheet of all sizes to this file")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	sizes := []int{16, 32, 48, 256}
	icons := map[int]*image.NRGBA{}
	for _, size := range sizes {
		icons[size] = render(size)
		writePNG(filepath.Join(*out, fmt.Sprintf("icon%d.png", size)), icons[size])
	}
	if *preview != "" {
		writePNG(*preview, contactSheet(icons, []int{256, 48, 32, 16}))
	}
}
