package pathguard

import (
	"strings"
	"testing"
)

type cleanCase struct {
	in   string
	want string // "" means "must be rejected"
	kind Kind   // expected Kind when rejected
}

func runCleanCases(t *testing.T, f Flavor, cases []cleanCase) {
	t.Helper()
	for _, c := range cases {
		got, err := f.Clean(c.in)
		if c.want == "" {
			if err == nil {
				t.Errorf("%s Clean(%q) = %q, want rejection", f.Name(), c.in, got)
				continue
			}
			if KindOf(err) != c.kind {
				t.Errorf("%s Clean(%q) kind = %v (%v), want %v", f.Name(), c.in, KindOf(err), err, c.kind)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s Clean(%q) unexpected error: %v", f.Name(), c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s Clean(%q) = %q, want %q", f.Name(), c.in, got, c.want)
		}
	}
}

func TestPosixClean(t *testing.T) {
	runCleanCases(t, Posix, []cleanCase{
		{in: "/", want: "/"},
		{in: "/media/card", want: "/media/card"},
		{in: "/media/card/", want: "/media/card"},
		{in: "/media//card/./DCIM", want: "/media/card/DCIM"},
		{in: "/media/card/DCIM/../x.bin", want: "/media/card/x.bin"},
		{in: "/media/card/../../etc/passwd", want: "/etc/passwd"}, // cleaned; containment is checked later
		{in: "/a/b/..", want: "/a"},
		{in: "/a/...", want: "/a/..."},
		{in: "/a/ b .txt", want: "/a/ b .txt"},
		{in: "/a/日本語/ファイル.bin", want: "/a/日本語/ファイル.bin"},

		{in: "", kind: Invalid},
		{in: "relative/path", kind: Forbidden},
		{in: "./x", kind: Forbidden},
		{in: "..", kind: Forbidden},
		{in: "/..", kind: Forbidden},
		{in: "/a/../..", kind: Forbidden},
		{in: "/a/../../etc", kind: Forbidden},
		{in: `/media/card\..\..\etc`, kind: Forbidden},
		{in: `\media\card`, kind: Forbidden},
		{in: `C:\Windows`, kind: Forbidden},
		{in: "/a/b\x00c", kind: Forbidden},
		{in: "/a/b\nc", kind: Forbidden},
		{in: "/a/\x7f", kind: Forbidden},
		{in: "/a/\xff\xfe", kind: Forbidden},
		{in: "/" + strings.Repeat("a/", 3000), kind: Forbidden},
	})
}

func TestWindowsClean(t *testing.T) {
	runCleanCases(t, Windows, []cleanCase{
		{in: `E:\`, want: `E:\`},
		{in: `e:\`, want: `E:\`},
		{in: `E:/`, want: `E:\`},
		{in: `E:\DCIM`, want: `E:\DCIM`},
		{in: `E:\DCIM\`, want: `E:\DCIM`},
		{in: `E:/DCIM/100RICOH/R0001234.DNG`, want: `E:\DCIM\100RICOH\R0001234.DNG`},
		{in: `E:\DCIM/100RICOH\\x.jpg`, want: `E:\DCIM\100RICOH\x.jpg`},
		{in: `E:\DCIM\.\x`, want: `E:\DCIM\x`},
		{in: `E:\DCIM\..\x.bin`, want: `E:\x.bin`},
		{in: `E:\a\b\..\..\c`, want: `E:\c`},
		{in: `E:\a\..`, want: `E:\`},
		{in: `E:\My Folder\a.b.c`, want: `E:\My Folder\a.b.c`},
		{in: `E:\ leading space`, want: `E:\ leading space`},
		{in: `E:\.hidden`, want: `E:\.hidden`},
		{in: `E:\..hidden`, want: `E:\..hidden`},
		{in: `E:\写真\フィルム.bin`, want: `E:\写真\フィルム.bin`},
		{in: `E:\CONSOLE.txt`, want: `E:\CONSOLE.txt`},
		{in: `E:\COM10`, want: `E:\COM10`},
		{in: `E:\nullable`, want: `E:\nullable`},
		{in: `E:\a$b#c!d@e%f^g&h(i)j-k_l+m=n[o]p{q}r;s'u,v~w`, want: `E:\a$b#c!d@e%f^g&h(i)j-k_l+m=n[o]p{q}r;s'u,v~w`},

		{in: ``, kind: Invalid},

		// Not a fully qualified drive path.
		{in: `E:`, kind: Forbidden},
		{in: `E:foo`, kind: Forbidden},
		{in: `E:..\foo`, kind: Forbidden},
		{in: `\Windows\System32`, kind: Forbidden},
		{in: `/Windows/System32`, kind: Forbidden},
		{in: `Windows\System32`, kind: Forbidden},
		{in: `..\x`, kind: Forbidden},
		{in: `1:\x`, kind: Forbidden},
		{in: `EE:\x`, kind: Forbidden},
		{in: `/media/card`, kind: Forbidden},

		// UNC and device namespaces, in every slash spelling.
		{in: `\\server\share\x`, kind: Forbidden},
		{in: `//server/share/x`, kind: Forbidden},
		{in: `\\?\E:\x`, kind: Forbidden},
		{in: `//?/E:/x`, kind: Forbidden},
		{in: `\/?/E:/x`, kind: Forbidden},
		{in: `\\.\E:`, kind: Forbidden},
		{in: `\\.\PhysicalDrive0`, kind: Forbidden},
		{in: `//./E:/x`, kind: Forbidden},
		{in: `\\?\UNC\server\share`, kind: Forbidden},
		{in: `\\?\Volume{b75e2c83-0000-0000-0000-602f00000000}\x`, kind: Forbidden},
		{in: `\??\E:\x`, kind: Forbidden},
		{in: `\\localhost\C$\Windows`, kind: Forbidden},
		{in: `E:\\?\C:\Windows`, kind: Forbidden},
		{in: `E:\\.\C:\Windows`, kind: Forbidden},

		// ".." above the root.
		{in: `E:\..`, kind: Forbidden},
		{in: `E:\..\x`, kind: Forbidden},
		{in: `E:\a\..\..\x`, kind: Forbidden},
		{in: `E:/a/../../Windows`, kind: Forbidden},
		{in: `E:\a\..\..\..\C:\Windows`, kind: Forbidden},

		// Alternate data streams and stray colons.
		{in: `E:\file.txt:stream`, kind: Forbidden},
		{in: `E:\file.txt::$DATA`, kind: Forbidden},
		{in: `E:\dir:$I30:$INDEX_ALLOCATION`, kind: Forbidden},
		{in: `E:\dir\C:\Windows`, kind: Forbidden},
		{in: `E:\a\:`, kind: Forbidden},

		// Trailing dots and spaces are stripped by Win32, so "x." aliases "x".
		{in: `E:\file.`, kind: Forbidden},
		{in: `E:\file `, kind: Forbidden},
		{in: `E:\dir.\file`, kind: Forbidden},
		{in: `E:\dir \file`, kind: Forbidden},
		{in: `E:\...`, kind: Forbidden},
		{in: `E:\a\...\b`, kind: Forbidden},
		{in: `E:\a\.. \b`, kind: Forbidden},
		{in: `E:\a\. \b`, kind: Forbidden},
		{in: `E:\a\ `, kind: Forbidden},
		{in: `E:\DCIM\..\..\.. \Windows`, kind: Forbidden},

		// Wildcards and other reserved characters.
		{in: `E:\*.jpg`, kind: Forbidden},
		{in: `E:\a?b`, kind: Forbidden},
		{in: `E:\a<b`, kind: Forbidden},
		{in: `E:\a>b`, kind: Forbidden},
		{in: `E:\a"b`, kind: Forbidden},
		{in: `E:\a|b`, kind: Forbidden},

		// Reserved device names.
		{in: `E:\NUL`, kind: Forbidden},
		{in: `E:\nul`, kind: Forbidden},
		{in: `E:\NUL.txt`, kind: Forbidden},
		{in: `E:\dir\CON`, kind: Forbidden},
		{in: `E:\con.tar.gz`, kind: Forbidden},
		{in: `E:\PRN`, kind: Forbidden},
		{in: `E:\aux\x`, kind: Forbidden},
		{in: `E:\COM1`, kind: Forbidden},
		{in: `E:\com9.log`, kind: Forbidden},
		{in: "E:\\COM\u00b9", kind: Forbidden},
		{in: `E:\LPT1`, kind: Forbidden},
		{in: `E:\CONIN$`, kind: Forbidden},
		{in: `E:\conout$`, kind: Forbidden},
		{in: `E:\NUL .txt`, kind: Forbidden},

		// Control characters and bad encodings.
		{in: "E:\\a\x00b", kind: Forbidden},
		{in: "E:\\a\tb", kind: Forbidden},
		{in: "E:\\a\r\nb", kind: Forbidden},
		{in: "E:\\\xff", kind: Forbidden},
		{in: `E:\` + strings.Repeat(`a\`, 3000), kind: Forbidden},
	})
}

func TestWithin(t *testing.T) {
	cases := []struct {
		f       Flavor
		root, p string
		want    bool
	}{
		{Posix, "/", "/", true},
		{Posix, "/", "/a", true},
		{Posix, "/media/card", "/media/card", true},
		{Posix, "/media/card", "/media/card/DCIM/x", true},
		{Posix, "/media/card", "/media/card2", false},
		{Posix, "/media/card", "/media/cardx/y", false},
		{Posix, "/media/card", "/media", false},
		{Posix, "/media/card", "/media/Card/x", false},
		{Posix, "/media/card", "/etc/passwd", false},

		{Windows, `E:\`, `E:\`, true},
		{Windows, `E:\`, `E:\DCIM\x`, true},
		{Windows, `E:\`, `e:\DCIM`, true},
		{Windows, `E:\`, `F:\DCIM`, false},
		{Windows, `E:\`, `C:\Windows`, false},
		{Windows, `C:\Users\me\Presets`, `C:\Users\me\Presets`, true},
		{Windows, `C:\Users\me\Presets`, `C:\USERS\ME\PRESETS\a.xmp`, true},
		{Windows, `C:\Users\me\Presets`, `C:\Users\me\Presets2\a.xmp`, false},
		{Windows, `C:\Users\me\Presets`, `C:\Users\me\PresetsX`, false},
		{Windows, `C:\Users\me\Presets`, `C:\Users\me`, false},
		{Windows, `C:\Users\me\Presets`, `C:\Users\other\Presets`, false},
		{Windows, `C:\Users\me\Presets`, `D:\Users\me\Presets`, false},
	}
	for _, c := range cases {
		if got := Within(c.f, c.root, c.p); got != c.want {
			t.Errorf("%s Within(%q, %q) = %v, want %v", c.f.Name(), c.root, c.p, got, c.want)
		}
	}
}

func TestSameVolume(t *testing.T) {
	if !SameVolume(Windows, `E:\a`, `e:\b\c`) {
		t.Error("E: and e: must be the same volume")
	}
	if SameVolume(Windows, `E:\a`, `F:\a`) {
		t.Error("E: and F: must differ")
	}
	if !SameVolume(Posix, "/a", "/b") {
		t.Error("posix paths share the single root")
	}
}

func TestSplitJoinRoundTrip(t *testing.T) {
	for _, c := range []struct {
		f Flavor
		p string
		n int
	}{
		{Posix, "/", 0}, {Posix, "/a", 1}, {Posix, "/a/b/c", 3},
		{Windows, `E:\`, 0}, {Windows, `E:\a`, 1}, {Windows, `E:\a\b c\d`, 3},
	} {
		vol, parts := c.f.split(c.p)
		if len(parts) != c.n {
			t.Errorf("%s split(%q) gave %d parts, want %d", c.f.Name(), c.p, len(parts), c.n)
		}
		if got := c.f.join(vol, parts); got != c.p {
			t.Errorf("%s join(split(%q)) = %q", c.f.Name(), c.p, got)
		}
	}
}

func TestReservedWindowsName(t *testing.T) {
	for _, n := range []string{"nul", "NUL", "con.txt", "aux", "prn.a.b", "com1", "LPT9", "com0", "nul.", "con "} {
		if !IsReservedWindowsName(n) {
			t.Errorf("%q should be reserved", n)
		}
	}
	for _, n := range []string{"null", "console", "com", "com10", "lpt", "a.nul", "settings.json", "nu"} {
		if IsReservedWindowsName(n) {
			t.Errorf("%q should not be reserved", n)
		}
	}
}
