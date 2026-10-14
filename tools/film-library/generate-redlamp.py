"""Adapt pinned Redlamp scene-log / Rec.2020 look tables to display-sRGB.

The input is decoded display sRGB used as a scene-light proxy, not a recovered RAW.
Tetrahedral interpolation follows LookTable.sample in the referenced MPL source.
"""
from pathlib import Path
import base64, ctypes, hashlib, json
import numpy as np
import colour

ROOT=Path(__file__).resolve().parents[2]
UP=ROOT/'research/film-library-120/upstream/redlamp'
OUT=ROOT/'research/film-library-120/sources/generated'
OUT.mkdir(parents=True,exist_ok=True)
lib=ctypes.CDLL('/usr/lib/libcompression.dylib')
decode=lib.compression_decode_buffer
decode.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_int]
decode.restype=ctypes.c_size_t
def unpack(p):
    data=p.read_bytes(); dst=ctypes.create_string_buffer(4000000)
    n=decode(dst,len(dst),data,len(data),None,0x801)
    if not n: raise ValueError('LZFSE decode failed')
    return json.loads(dst.raw[:n])
def sample(table,coords):
    n=table.shape[0];p=np.clip(coords,0,1)*(n-1)
    lo=np.minimum(np.floor(p).astype(int),n-2);f=p-lo
    order=np.argsort(-f,axis=1);steps=np.eye(3,dtype=int)[order]
    v0=lo;v1=lo+steps[:,0];v2=v1+steps[:,1];v3=lo+1
    take=lambda v:table[v[:,2],v[:,1],v[:,0]]
    a,b,c,d=map(take,[v0,v1,v2,v3]);weights=np.take_along_axis(f,order,axis=1)
    return a+weights[:,0,None]*(b-a)+weights[:,1,None]*(c-b)+weights[:,2,None]*(d-c)
ax=np.linspace(0,1,33);points=np.array([(r,g,b) for b in ax for g in ax for r in ax])
srgb=colour.RGB_COLOURSPACES['sRGB']; rec=colour.RGB_COLOURSPACES['ITU-R BT.2020']
linear=srgb.cctf_decoding(points)
scene=colour.RGB_to_RGB(linear,srgb,rec)
coords=np.clip((np.log2(np.maximum(scene,1e-9)/.18)+10)/16.5,0,1)
for ident,filename in [('cinestill-50d','stock-cinestill-50d'),('kodak-ektachrome-e100','stock-ektachrome-e100@2'),('fujifilm-eterna-vivid-250d','stock-eterna-vivid-250d-2383')]:
    p=UP/'packages/RedlampRecipes/Resources/BaseLooks'/(filename+'.json.lzfse')
    d=unpack(p);t=d['table'];assert t['space']=='sceneLog'
    raw=base64.b64decode(t['data']);size=t['size']
    table=np.frombuffer(raw,dtype='<f2').astype(float).reshape(size,size,size,3)
    def transform(q):
        v=sample(table,q)
        return np.clip(srgb.cctf_encoding(colour.RGB_to_RGB(srgb.cctf_decoding(v),rec,srgb)),0,1)
    values=transform(coords)
    assert np.isfinite(values).all() and np.ptp(values,axis=0).min()>.2
    (OUT/(ident+'.cube')).write_text('\n'.join([f'TITLE "{d["name"]}"','# Scene-log Rec2020 to display-sRGB adapter','LUT_3D_SIZE 33']+[' '.join(f'{v:.8f}' for v in row) for row in values])+'\n')
    meta=dict(provider='Redlamp · sRGB 适配',url='https://github.com/pdcgomes/redlamp',commit='773c412be2f2b786697d353d12c6a2ac6eba5687',license='MPL-2.0',sha256=hashlib.sha256(p.read_bytes()).hexdigest(),model=d['id'],version=d['version'],table=t.get('contentHash'),
        note='原模型使用场景光与 Rec.2020。本适配将解码后的 sRGB 作为场景光近似，再转回 sRGB；不包含光晕或颗粒，尚待相机实拍。')
    (OUT/(ident+'.json')).write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
    print(ident,size,'range',values.min(),values.max(),flush=True)
