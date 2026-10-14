"""Explicit sRGB-to-sRGB adapters for pinned Spectral Film LUT models."""
from pathlib import Path
import sys, os, json, hashlib
REPO=Path(__file__).resolve().parents[2]
UP=REPO/'research/film-library-120/upstream/spectral'
sys.path.insert(0,str(UP/'src'))
os.environ.setdefault('MPLBACKEND','Agg')
import numpy as np
import spectral_film_lut as stocks
from spectral_film_lut.film_spectral import FilmSpectral
from spectral_film_lut.utils import film_conversion

CAT=json.loads((REPO/'ui/public/film-library/catalog.json').read_text())
OUT=REPO/'research/film-library-120/sources/generated';OUT.mkdir(exist_ok=True)
PIN='6307a98f3cf4f2d7b6d09bab82fbf6f64356ccfe'
cache={}
def film(name):
    if name not in cache:cache[name]=FilmSpectral(getattr(stocks,name))
    return cache[name]
axis=np.linspace(0,1,33)
points=np.array([(r,g,b) for b in axis for g in axis for r in axis])
reports=[]
for stock in CAT['stocks']:
    if stock['status']=='ready':continue
    entry=next((e for e in stock['sources'] if e['source']=='spectral'),None)
    if not entry:continue
    name=entry['name'].upper();dest=OUT/(stock['id']+'.cube')
    if dest.exists():continue
    try:
        negative=film(name)
        if stock['category']=='电影黑白负片':paper='KODAK_POLYMAX_GRADE_2'
        elif stock['category']=='电影彩色负片':paper='KODAK_2383'
        elif stock['category']=='彩色负片':paper='KODAK_ENDURA_PREMIER'
        else:paper=None
        options=dict(input_colorspace='sRGB',output_gamut='Rec. 709',gamma_func='sRGB',
                     exp_comp=0.0,exp_kelvin=6500,projector_kelvin=6500,white_clip=True,
                     white_balance=1,shadow_comp=0.0,upsampling_method='SFL upsampling')
        values=film_conversion(points,negative,film(paper) if paper else None,**options)
        if values.shape != points.shape or not np.isfinite(values).all():raise ValueError('Invalid RGB samples')
        values=np.clip(values,0,1)
        if np.std(values)<0.03:raise ValueError('Degenerate film transform')
        head=[f'TITLE "{stock["name"]} - Spectral sRGB adapter"',
              '# Based on Jan Lohse Spectral Film LUT (MIT), '+PIN,
              '# Display-sRGB adapter: decoded input is used as an approximate scene. No grain/halation.',
              '# Print medium: '+str(paper),'LUT_3D_SIZE 33','DOMAIN_MIN 0 0 0','DOMAIN_MAX 1 1 1']
        text='\n'.join(head+[' '.join(f'{x:.8f}' for x in row) for row in values])+'\n'
        dest.write_text(text)
        ramp=film_conversion(np.tile(np.linspace(0,1,17)[:,None],(1,3)),negative,film(paper) if paper else None,**options)
        meta=dict(provider='Spectral Film LUT · sRGB 适配',url=entry['page'],commit=PIN,license='MIT',
                  note='由公开光谱模型生成的实验性适配；以解码后的 sRGB 近似场景输入。仅色彩，不包含颗粒、光晕。',
                  film_model=name,print_model=paper,options=options,neutral_ramp=np.asarray(ramp).tolist(),
                  cube_sha256=hashlib.sha256(text.encode()).hexdigest())
        dest.with_suffix('.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
        rec=dict(id=stock['id'],ok=True,midgray=ramp[8].tolist());print(json.dumps(rec),flush=True);reports.append(rec)
    except Exception as e:
        rec=dict(id=stock['id'],ok=False,error=str(e));print(json.dumps(rec),flush=True);reports.append(rec)
(OUT/'spectral-report.json').write_text(json.dumps(reports,indent=2))
