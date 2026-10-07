#!/usr/bin/env python3
"""Pillow-side helper for jpeg.test.ts (test use only, never imported by src).

  pyjpeg.py probe
  pyjpeg.py crops <photo.jpg> <outdir>        720x480 RGB test images cut from a large photo
  pyjpeg.py decode <in.jpg> <out.rgb>         decode with Pillow (libjpeg) to raw RGB
  pyjpeg.py encode <in.rgb> <w> <h> <out.jpg> <quality> <subsampling> [progressive|optimize]

Every command prints one line of JSON.
"""
import json
import sys


def main() -> None:
    cmd = sys.argv[1]
    import PIL
    from PIL import Image

    if cmd == "probe":
        print(json.dumps({"pillow": PIL.__version__}))
    elif cmd == "crops":
        photo, outdir = sys.argv[2], sys.argv[3]
        im = Image.open(photo).convert("RGB")
        w, h = im.size
        out = {}

        def put(name, image):
            assert image.size == (720, 480)
            with open(f"{outdir}/{name}.rgb", "wb") as f:
                f.write(image.convert("RGB").tobytes())
            out[name] = f"{outdir}/{name}.rgb"

        # the whole frame, cropped to 3:2 and downscaled
        side = min(w, h * 3 // 2)
        box_w, box_h = side, side * 2 // 3
        left, top = (w - box_w) // 2, (h - box_h) // 2
        full = im.crop((left, top, left + box_w, top + box_h)).resize((720, 480), Image.LANCZOS)
        put("full", full)
        # centre 1440x960 downscaled 2:1
        put("centre", im.crop((w // 2 - 720, h // 2 - 480, w // 2 + 720, h // 2 + 480)).resize((720, 480), Image.LANCZOS))
        # two 1:1 crops (sensor-level detail and noise)
        put("pixels_a", im.crop((w // 4, h // 4, w // 4 + 720, h // 4 + 480)))
        put("pixels_b", im.crop((w * 2 // 5, h * 9 // 20, w * 2 // 5 + 720, h * 9 // 20 + 480)))
        # black-and-white version of the whole frame, stored as RGB
        put("bw", full.convert("L").convert("RGB"))
        print(json.dumps(out))
    elif cmd == "decode":
        im = Image.open(sys.argv[2])
        im.load()
        info = {
            "width": im.size[0],
            "height": im.size[1],
            "mode": im.mode,
            "format": im.format,
            "progressive": bool(im.info.get("progressive") or im.info.get("progression")),
            "layers": getattr(im, "layer", None),
        }
        with open(sys.argv[3], "wb") as f:
            f.write(im.convert("RGB").tobytes())
        print(json.dumps(info))
    elif cmd == "encode":
        src, w, h, dst, quality, subsampling = sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], int(sys.argv[6]), sys.argv[7]
        flags = sys.argv[8:]
        with open(src, "rb") as f:
            im = Image.frombytes("RGB", (w, h), f.read())
        im.save(dst, "JPEG", quality=quality, subsampling=subsampling, progressive="progressive" in flags, optimize="optimize" in flags)
        print(json.dumps({"ok": True}))
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
