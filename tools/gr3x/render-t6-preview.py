"""Render the code-native firmware icons at 1x and 5x, plus importable labels."""
from pathlib import Path
import json
import sys
from PIL import Image, ImageDraw, ImageFont


def render(directory):
    directory = Path(directory)
    sources = json.loads((directory / 'SOURCES.json').read_text())
    assert len(sources) == 9
    canvas = Image.new('RGB', (930, 760), '#f4f2ee')
    draw = ImageDraw.Draw(canvas)
    font_path = '/System/Library/Fonts/Helvetica.ttc'
    font = ImageFont.truetype(font_path, 22)
    small = ImageFont.truetype(font_path, 16)
    hashes = set()
    for i, source in enumerate(sources):
        name = source['name']
        stem = name.replace(' ', '-')
        raw = (directory / 'icons' / f'{stem}.rgba').read_bytes()
        assert len(raw) == 6400 and raw not in hashes
        hashes.add(raw)
        image = Image.frombytes('RGBA', (40, 40), raw)
        image.save(directory / 'icons' / f'{stem}.png')
        image.crop((2, 9, 38, 31)).save(directory / 'icons' / f'{stem}-label.png')
        x, y = 30 + (i % 3) * 310, 15 + (i // 3) * 245
        enlarged = image.resize((200, 200), Image.Resampling.NEAREST)
        canvas.paste(enlarged, (x, y), enlarged)
        draw.text((x, y + 203), name, font=font, fill='#212121')
        draw.text((x, y + 230), f'{i+1} / 9', font=small, fill='#626262')
    canvas.save(directory / 'T6-彩色图标预览.png')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: render-t6-preview.py T6-release-directory')
    render(sys.argv[1])
