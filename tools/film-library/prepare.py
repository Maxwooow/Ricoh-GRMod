"""Build a local, source-traceable film library; never invent missing LUTs."""
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import quote, unquote
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
import hashlib, io, json, gzip, shutil, zipfile, re, sys, os
import numpy as np
from PIL import Image, ImageCms

REPO = Path(__file__).resolve().parents[2]
PROJECT = REPO.parent
RESEARCH = REPO/'research/film-library-120'
SOURCE = RESEARCH/'sources'
PUBLIC = REPO/'ui/public/film-library'
ICONS = Path(os.environ.get('GRMOD_ICON_LIBRARY', PROJECT/'film-icons-120'))
for p in [SOURCE, PUBLIC/'icons', PUBLIC/'labels', PUBLIC/'cubes', PUBLIC/'fits', PUBLIC/'licenses']:
    p.mkdir(parents=True, exist_ok=True)
catalog = json.loads((ICONS/'图标与胶片对应表.json').read_text())
gmic = json.loads((PROJECT/'film-research/20261011/gmic-index.json').read_text())['presets']
t3tree = json.loads((PROJECT/'film-research/20261011/sources/t3mujinpack__t3mujinpack/tree.json').read_text())['tree']
T3 = '0b421f3e25209ed78253d1724a29cc6255c5e7fe'
sha = lambda b: hashlib.sha256(b).hexdigest()

def fetch(url, destination):
    if destination.exists(): return destination.read_bytes()
    data = urlopen(Request(url, headers={'User-Agent':'GRMod-local-film-library'}),timeout=60).read()
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_bytes(data)
    return data

def evaluate(table, points):
    grid=table.shape[0];q=np.clip(points,0,1)*(grid-1)
    lo=np.minimum(np.floor(q).astype(int),grid-2);f=q-lo;out=np.zeros(points.shape)
    for b in (0,1):
      for g in (0,1):
       for r in (0,1):
        w=(f[:,0] if r else 1-f[:,0])*(f[:,1] if g else 1-f[:,1])*(f[:,2] if b else 1-f[:,2])
        out+=table[lo[:,2]+b,lo[:,1]+g,lo[:,0]+r]*w[:,None]
    return out

def cube_from_hald(data,name):
    im=Image.open(io.BytesIO(data));profile='untagged sRGB Hald'
    if im.info.get('icc_profile'):
        profile=ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(im.info['icc_profile']))).strip()
        if 'srgb' not in profile.lower(): raise ValueError('Non-sRGB Hald: '+profile)
    if im.mode!='RGB' or im.width!=im.height: raise ValueError('Unexpected Hald format')
    n=round((im.width*im.height)**(1/3))
    if n**3!=im.width*im.height:raise ValueError('Hald dimensions')
    table=np.asarray(im).reshape(n,n,n,3).astype(float)/255
    ax=np.linspace(0,1,33);points=np.array([(r,g,b) for b in ax for g in ax for r in ax])
    values=evaluate(table,points)
    header=[f'TITLE "{name}"','# Display sRGB input/output; see library source manifest.','LUT_3D_SIZE 33','DOMAIN_MIN 0 0 0','DOMAIN_MAX 1 1 1']
    text='\n'.join(header+[' '.join(f'{x:.8f}' for x in row) for row in values])+'\n'
    return text,dict(hald_grid=n,profile=profile)

def save_cube(record,text,source):
    if not re.search(r'^LUT_3D_SIZE\s+\d+',text,re.M):raise ValueError('Not a 3D CUBE')
    data=text.encode();file=record['id']+'.cube.gz'
    (PUBLIC/'cubes'/file).write_bytes(gzip.compress(data,mtime=0))
    record.update(status='ready',cube='cubes/'+file,cubeSha256=sha(data),source=source)
    return record

def make(stock):
    ident=stock['id']; short=stock['name'].removeprefix(stock['brand']+' ')
    record=dict(id=ident,name=stock['name'],cameraName=short[:31],brand=stock['brand'],category=stock['category'],
                recipeVersion='T6-C1' if ident=='cinestill-800t' else 'T6' if stock['active_T6'] else '120-L1',
                icon='icons/'+ident+'.png',label='labels/'+ident+'.png',
                packaging=stock['package_reference']['method'],packagingUrl=stock['package_reference']['page'],
                status='pending',sources=stock['entries'],note=stock['note'],
                testedGr3x=bool(stock['active_T6'] and ident!='cinestill-800t'),testedGr4=False)
    for typ,path in [('icons','native'),('labels','import_label')]:
        shutil.copy2(ICONS/stock['paths'][path],PUBLIC/typ/(ident+'.png'))
    if stock['active_T6']:
        fn=short.replace(' ','-')+'.cube'
        p=REPO/'examples/gr3x/T6'/fn
        if ident=='cinestill-800t':p=REPO/'examples/gr3x/T6-C1/CineStill-800T-T6-C1.cube'
        record['cameraName']=short
        return save_cube(record,p.read_text(),dict(provider='T6-C1 当前方案',file=p.name,url='local-current',license='see T6 provenance'))
    # Generated from inspected models by the separate, pinned adapter.
    extra=SOURCE/'generated'/f'{ident}.cube'
    if extra.exists():
        meta=json.loads(extra.with_suffix('.json').read_text())
        return save_cube(record,extra.read_text(),meta)
    entries=stock['entries']; t3=next((e for e in entries if e['source']=='t3mujinpack'),None)
    gm=[e for e in entries if e['source']=='gmic']
    try:
      if t3:
        path=unquote(t3['page'].split(T3+'/')[-1])
        match=re.search(r't3mujinpack - (.+?)_(.+)\.dtstyle$',path)
        if not match:raise ValueError('Unrecognised t3 source '+path)
        filename=f't3mujinpack - {match[1]} - {match[2]}.png'
        tree=next((r for r in t3tree if r['path']=='haldcluts/'+filename),None)
        if tree:
          url=f'https://raw.githubusercontent.com/t3mujinpack/t3mujinpack/{T3}/'+quote(tree['path'])
          data=fetch(url,SOURCE/'t3mujinpack'/filename)
          assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==tree['sha']
          text,meta=cube_from_hald(data,stock['name'])
          return save_cube(record,text,dict(provider='t3mujinpack',url=url,commit=T3,license='MIT',sha256=sha(data),**meta))
      if gm:
        # Prefer the unsuffixed / standard version. All alternatives remain listed.
        exact=[e for e in gm if not re.search(r'(?:\+|\b(?:warm|cold|cool|soft|hard|high|low|early|late|alt|negative)\b)',e['name'],re.I)]
        e=(exact or gm)[0]
        item=next(g for g in gmic if g['name']==e['name'] and g['page']==e['page'])
        data=fetch(item['hald_url'],SOURCE/'gmic'/(ident+'.png'))
        text,meta=cube_from_hald(data,stock['name'])
        return save_cube(record,text,dict(provider="G'MIC Color Presets",name=e['name'],url=item['hald_url'],page=e['page'],license='G\'MIC CLUT collection; author attribution retained',sha256=sha(data),**meta))
      record['reason']='尚未取得可用的源文件，可在影像控制中导入自己持有的 CUBE。'
      if ident=='fujifilm-velvia-100f':
          record['reason']='对应来源为需另购的 Film Era 方案，尚未取得授权文件。图标已收录；持有该款 CUBE 后可自行导入。'
    except Exception as exc:
      record['reason']=str(exc)
    return record

if __name__=='__main__':
    records=[]
    with ThreadPoolExecutor(max_workers=6) as pool:
      futures={pool.submit(make,s):s for s in catalog['stocks']}
      for future in as_completed(futures):
        rec=future.result();records.append(rec)
        print(rec['status'],rec['id'],rec.get('reason',''),flush=True)
    records.sort(key=lambda x:(x['category'],x['brand'],x['name']))
    result=dict(schema=1,version='120-L1',count=120,stocks=records)
    (PUBLIC/'catalog.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print('TOTAL',Counter(r['status'] for r in records))
