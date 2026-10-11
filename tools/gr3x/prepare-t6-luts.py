"""Fetch pinned film sources and convert Hald RGB data to display-RGB CUBE.

Hald and CUBE both enumerate red fastest, then green, then blue. The Hald
conversion only resamples a lookup table; it does not grade a user's photograph.
"""
from pathlib import Path
from io import BytesIO
from urllib.parse import quote
from urllib.request import Request, urlopen
import concurrent.futures
import hashlib
import json
import shutil
import numpy as np
from PIL import Image, ImageCms

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'examples/gr3x/T6'
PIN = '0b421f3e25209ed78253d1724a29cc6255c5e7fe'
SELECTED = [
    ('Provia 100F', 'Color Slide', 'Fuji Provia 100F'),
    ('Provia 400F', 'Color Slide', 'Fuji Provia 400F'),
    ('Velvia 50', 'Color Slide', 'Fuji Velvia 50'),
    ('Velvia 100', 'Color Slide', 'Fuji Velvia 100'),
    ('Portra 400', 'Color Negative', 'Kodak Portra 400'),
    ('Gold 200', 'Color Negative', 'Kodak Gold 200'),
    ('Ektar 100', 'Color Negative', 'Kodak Ektar 100'),
    ('Kodachrome 64', 'Color Slide', 'Kodak Kodakchrome 64'),
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def evaluate_hald(table, points):
    grid = table.shape[0]
    q = np.clip(points, 0, 1) * (grid - 1)
    lo = np.minimum(np.floor(q).astype(int), grid - 2)
    f = q - lo
    out = np.zeros(points.shape, dtype=float)
    for b in (0, 1):
        for g in (0, 1):
            for r in (0, 1):
                w = (f[:, 0] if r else 1-f[:, 0]) * (f[:, 1] if g else 1-f[:, 1]) * (f[:, 2] if b else 1-f[:, 2])
                out += table[lo[:, 2]+b, lo[:, 1]+g, lo[:, 0]+r] * w[:, None]
    return out


def cube_text(name, table, size=33):
    points = np.array([(r, g, b) for b in np.linspace(0, 1, size)
                       for g in np.linspace(0, 1, size) for r in np.linspace(0, 1, size)])
    values = evaluate_hald(table, points)
    header = [f'TITLE "{name} - t3mujinpack"', '# Source: t3mujinpack MIT; see SOURCES.json and LICENSE-t3mujinpack.txt',
              '# Display RGB Hald resampling. GR IIIx hardware rendering is not yet verified.',
              f'LUT_3D_SIZE {size}', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1']
    return '\n'.join(header + [' '.join(f'{v:.8f}' for v in row) for row in values]) + '\n', values.reshape(size, size, size, 3)


def acquire(item):
    name, category, source_name = item
    filename = f't3mujinpack - {category} - {source_name}.png'
    path = 'haldcluts/' + filename
    url = f'https://raw.githubusercontent.com/t3mujinpack/t3mujinpack/{PIN}/{quote(path)}'
    cached = DEST / 'sources' / filename
    data = cached.read_bytes() if cached.exists() else urlopen(Request(url, headers={'User-Agent': 'GRMod-film-research'}), timeout=45).read()
    provenance_file = DEST / 'SOURCES.json'
    previous = json.loads(provenance_file.read_text()) if provenance_file.exists() else []
    known = next((r for r in previous if r['name'] == name and r.get('source_commit') == PIN), None)
    if known:
        assert digest(data) == known['source_sha256'], 'Pinned Hald source changed'
    else:
        tree_url = f'https://api.github.com/repos/t3mujinpack/t3mujinpack/git/trees/{PIN}?recursive=1'
        tree = json.loads(urlopen(Request(tree_url, headers={'User-Agent': 'GRMod-film-research'}), timeout=45).read())
        expected = next(x['sha'] for x in tree['tree'] if x['path'] == path)
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == expected
    source = DEST / 'sources' / filename
    source.write_bytes(data)
    im = Image.open(source)
    assert im.mode == 'RGB' and im.width == im.height
    profile = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(BytesIO(im.info['icc_profile']))).strip()
    assert profile == 'sRGB', 'Hald uses an unexpected output profile'
    grid = round((im.width * im.height) ** (1/3))
    assert grid**3 == im.width * im.height
    table = np.asarray(im).reshape(grid, grid, grid, 3).astype(float) / 255
    text, resized = cube_text(name, table)
    sample = np.random.default_rng(160).random((10000, 3))
    difference = np.abs(evaluate_hald(table, sample) - evaluate_hald(resized, sample))
    filename_out = name.replace(' ', '-') + '.cube'
    (DEST / filename_out).write_text(text)
    return dict(name=name, file=filename_out, source='t3mujinpack', source_name=source_name, source_url=url,
                source_file=str(source.relative_to(DEST)), source_commit=PIN, source_sha256=digest(data),
                cube_sha256=digest(text.encode()), hald_grid=grid, cube_grid=33, source_png_mode=im.mode,
                source_png_metadata=list(im.info), source_icc_profile=profile, input_encoding='display-sRGB',
                resample_mean_abs=float(difference.mean()), resample_p99_abs=float(np.quantile(difference,.99)),
                camera_verified=False)


def main():
    (DEST / 'sources').mkdir(parents=True, exist_ok=True)
    # Independent channel-order check on an analytic RGB transform.
    axis = np.linspace(0, 1, 4)
    identity = np.array([(.1+.8*r, .2+.7*g, .3+.6*b) for b in axis for g in axis for r in axis]).reshape(4,4,4,3)
    point = np.array([[.2,.4,.8], [1,0,0], [0,1,1]])
    assert np.allclose(evaluate_hald(identity, point), point*np.array([.8,.7,.6])+np.array([.1,.2,.3]))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(acquire, SELECTED))
    url = 'https://drive.usercontent.google.com/download?id=1wcHcKKY2AW6vK-2i5MuB1OJglQ-qU6yw&export=download'
    source = DEST / 'sources/CineStill-800-T-V2.0-N125.cube'
    if not source.exists():
        data = urlopen(Request(url, headers={'User-Agent':'GRMod-film-research'}), timeout=60).read()
        assert b'LUT_3D_SIZE' in data and b'<html' not in data[:200].lower(), 'Author CUBE download unavailable'
        source.write_bytes(data)
    data = source.read_bytes()
    assert digest(data) == '2f0a5c8e72588cbe23c65fe4306604c84cd2f69c212b78c82903181671afab44', 'Pinned PictureFX source changed'
    shutil.copy2(source, DEST / 'CineStill-800T.cube')
    records.append(dict(name='CineStill 800T', file='CineStill-800T.cube', source='PictureFX',
                        source_name='CineStill 800T v2.0 N125',
                        source_url='https://marcrphoto.wordpress.com/2025/02/28/picturefx-cinestill-800t-v2-0-lut/',
                        download_url=url, source_file=str(source.relative_to(DEST)), source_sha256=digest(data), cube_sha256=digest(data),
                        input_encoding='display-sRGB', camera_verified=False,
                        note='Marc Roovers; author free personal download, v2 without 85B correction. Colour LUT only, no spatial halation. Source kept unchanged.'))
    license_file = DEST / 'LICENSE-t3mujinpack.txt'
    if not license_file.exists():
        license_file.write_bytes(urlopen(Request(f'https://raw.githubusercontent.com/t3mujinpack/t3mujinpack/{PIN}/LICENSE.txt', headers={'User-Agent': 'GRMod-film-research'}), timeout=45).read())
    (DEST / 'SOURCES.json').write_text(json.dumps(records, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(records, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
