"""Unambiguous six-character menu aliases for the GR IV Chinese name slots."""
import re
SPECIAL={
 'FP-3000B':'F3000B','Instax Color':'INSTAX','PX-100 UV+':'PX100U','Time-Zero':'TZERO',
 'Aerochrome III':'AERIII','Polachrome':'PLCHRM','Aerocolor':'AERCOL','Vericolor III':'VERIII',
 'Eastman 5247 (1950)':'5247A','Eastman 5247 II':'5247B','Eastman 5248 (1952)':'5248A',
 'Eastman 5250':'E5250','BW400CN':'BW4CN','HIE Infrared':'HIEIR','Pan F Plus 50':'PANF+',
 'FP4 Plus 125':'FP4+','HP5 Plus 400':'HP5+','Retro 100 Tonal':'RT100T',
}
PREFIXES=[
 ('Neopan Acros','AC'),('Neopan','NP'),('Portrait XPS','XPS'),('Ultra Color','UC'),('Ultra','UL'),('Vista','VT'),
 ('Precisa','PC'),('Astia','AS'),('Fortia SP','FTSP'),('Provia','PR'),('Sensia','SN'),('Velvia','VL'),
 ('Ektachrome E','E'),('Ektachrome','E'),('Elite Chrome','EC'),('Elite ExtraColor','EX'),('Elite Color','ELC'),
 ('Kodachrome','KC'),('X-Pro Slide','XP'),('CineStill','CS'),('Natura','NA'),
 ('Superia X-Tra','XT'),('Superia Reala','RE'),('Superia HG','HG'),('Superia','SU'),('Pro','P'),
 ('ColorPlus','CP'),('Ektar','EK'),('Gold','GD'),('Portra','P'),('UltraMax','UM'),('Redscale','RS'),
 ('Eterna Vivid','EV'),('Eterna','ET'),('Delta','D'),('T-Max','TM'),('Tri-X','TX'),('Ortho','OR'),('Retro','RT'),
]
def menu_names(stock):
    n=stock['cameraName']
    if stock['brand']=='CineStill':n=stock['name']
    code=SPECIAL.get(n)
    if not code:
        if n.startswith('Vision3 '):code='V3'+n.split()[-1]
        elif n.startswith('Vision '):code='V1'+n.split()[-1]
        elif n.startswith('EXR '):code='EX'+n.split()[-1]
        elif n.startswith('Verita '):code='VT'+n.split()[-1]
        elif n.startswith('Double-X '):code='DX'+n.split()[-1]
        else:
            code=n
            for prefix,short in PREFIXES:
                if n.startswith(prefix+' '):code=short+n[len(prefix):];break
            code=re.sub(r'[^A-Za-z0-9+]','',code).upper()
    assert len(code)<=6,(n,code)
    compact=n.replace('Vision3 ','V3 ').replace('Eastman ','E. ').replace('Ektachrome ','Ekt. ').replace('Neopan Acros ','Acros ')
    return dict(cameraName=n,compactName=compact,shortName=code)
