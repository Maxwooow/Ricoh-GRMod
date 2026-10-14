"""Seal the precomputed family fits and retain source notices in the shipped library."""
from pathlib import Path
import json, hashlib, shutil, gzip
from collections import Counter
from PIL import Image
from names import menu_names

ROOT=Path(__file__).resolve().parents[2]
PUBLIC=ROOT/'ui/public/film-library'
RESEARCH=ROOT/'research/film-library-120'
sha=lambda b:hashlib.sha256(b).hexdigest()
path=PUBLIC/'catalog.json'; catalog=json.loads(path.read_text())
for stock in catalog['stocks']:
    stock.update(menu_names(stock))
    assert Image.open(PUBLIC/stock['icon']).size==(40,40)
    assert Image.open(PUBLIC/stock['label']).size==(36,22)
    stock['iconSha256']=sha((PUBLIC/stock['icon']).read_bytes())
    stock['labelSha256']=sha((PUBLIC/stock['label']).read_bytes())
    if stock['status']!='ready':continue
    assert sha(gzip.decompress((PUBLIC/stock['cube']).read_bytes()))==stock['cubeSha256']
    stock['fits']={}
    for family in ['gr3x','gr4']:
        data=(PUBLIC/'fits'/f'{stock["id"]}-{family}.json').read_bytes();f=json.loads(data)
        assert f['family']==family and f['sourceSha256']==stock['cubeSha256'] and f['id']==stock['id']
        r=f['result']
        stock['fits'][family]=dict(meanDE=r['meanDE'],p95DE=r['p95DE'],sha256=sha(data))
assert len(set(s['shortName'] for s in catalog['stocks']))==120, 'Menu aliases must be unique'
for src,name in [
    (ROOT.parent/'film-research/20261011/sources/t3mujinpack__t3mujinpack/LICENSE.txt','t3mujinpack.txt'),
    (RESEARCH/'upstream/spectral/LICENSE','spectral-film-lut.txt'),
    (RESEARCH/'upstream/moderate/LICENSE.md','moderate-noncommercial.txt'),
    (RESEARCH/'upstream/redlamp/LICENSE','redlamp-mpl.txt')]:shutil.copy2(src,PUBLIC/'licenses'/name)
(PUBLIC/'licenses/README.txt').write_text('''Local film library 120-L1

Each stock records its exact source URL, source hash and pinned commit where applicable.
Original upstream files and adapter source are retained under research/film-library-120
and tools/film-library in the accompanying local source repository.

t3mujinpack: Joao Pedro Almeida and contributors; MIT (included).
G'MIC color-presets: https://gmic.eu/color_presets/ ; original collection and preset authors
are retained in each catalogue entry. No claim is made that every collected preset
has the same license. This bundle is a personal local research installation.
Spectral Film LUT: Jan Lohse and contributors; MIT (included).
Moderate Film Simulator: PolyForm Noncommercial 1.0.0 (included); personal noncommercial use.
Redlamp: MPL 2.0 (included); original model tables and source are preserved locally.
Film names and package-inspired icons identify the corresponding products and are not
manufacturer endorsements. 119 usable sources; Velvia 100F awaits a legitimately acquired CUBE.

These are color/tone approximations. They do not reproduce grain, halation or film scanning
as spatial effects. A successful binary build is not a camera hardware test.
''')
path.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
summary=dict(count=catalog['count'],status=dict(Counter(s['status'] for s in catalog['stocks'])),
    familyFits={f:sum(f in s.get('fits',{}) for s in catalog['stocks']) for f in ['gr3x','gr4']},
    sourceProviders=dict(Counter(s.get('source',{}).get('provider','pending') for s in catalog['stocks'])),
    catalogSha256=sha(path.read_bytes()))
(RESEARCH/'manifest-validation.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False))
