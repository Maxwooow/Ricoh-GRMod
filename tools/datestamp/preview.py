"""Render a visual comparison using the actual compiled ARM watermark module."""
import importlib.util
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('render', root / 'render_check.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
canvas = Image.new('RGB', (1000, 280), (36, 34, 27))
for index, setting in enumerate((5, 7)):
    r = m.run(setting, 1920, 1280, 1920, 1280, clock=(2026, 10, 19, 17, 34, 53), style=34, name='KODAK GOLD 200')
    rows, crows = r['main'], r['mainc']
    x0, y0, x1, y1 = m.bbox_rows(rows, 1920, 70)
    out = Image.new('RGB', (x1-x0+33, y1-y0+33), (36, 34, 27))
    for y in range(y0, y1+1):
        for x in range(x0, x1+1):
            value = rows[y][x]
            if value == 70:
                continue
            cb, cr = crows[y][x & ~1]-128, crows[y][(x & ~1)+1]-128
            rgb = (1.164*(value-16)+1.596*cr, 1.164*(value-16)-.392*cb-.813*cr, 1.164*(value-16)+2.017*cb)
            out.putpixel((x-x0+16, y-y0+16), tuple(max(0, min(255, round(v))) for v in rgb))
    out.thumbnail((960, 110))
    canvas.paste(out, (20, index*140+20))
path = m.ROOT / 'scratch/watermark-preview/styles.png'
path.parent.mkdir(parents=True, exist_ok=True)
canvas.save(path)
print(path)
