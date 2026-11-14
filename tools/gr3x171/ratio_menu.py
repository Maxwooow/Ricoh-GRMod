"""The aspect-ratio menu a manifest declares, checked against the build rules.

Kept independent of the TypeScript builder: ratios are parsed with Python fractions and
every probe derives its expected geometry from them. Manifests made before custom ratios
(no 'menu' field) describe the T4 menu.
"""
from fractions import Fraction
import re

T4 = [('4:3',4),('3:2',0),('16:9',5),('65:24',6),('17:6',7),('3:4',8),('1:1',3),('7:6',9),('5:4',10)]
MAX_CUSTOM = 7
FIRST = 4

def parse(text):
    fields = re.split('[:：/]', text.strip())
    if len(fields) not in (1, 2) or not all(re.fullmatch(r'\d+(\.\d+)?', f.strip()) for f in fields):
        raise ValueError('bad ratio '+repr(text))
    a = Fraction(fields[0].strip()); b = Fraction(fields[1].strip()) if len(fields) == 2 else Fraction(1)
    if a <= 0 or b <= 0: raise ValueError('bad ratio '+repr(text))
    return a / b

class Menu:
    def __init__(self, rows):
        self.rows = rows                      # [(ratio, name, id)] in menu order
        self.order = [i for _, _, i in rows]
        customs = sorted((i, parse(r)) for r, _, i in rows if i >= FIRST)
        self.custom = [(i, f.numerator, f.denominator) for i, f in customs]
        self.max_id = FIRST - 1 + len(self.custom)
        self.wide = tuple(i for i, n, d in self.custom if n * 2 > d * 3)
        self.user_ids = tuple(sorted(self.order))
        self.names = {i: name for _, name, i in rows}
        self.ratios = {i: r for r, _, i in rows}

def menu(manifest):
    source = manifest.get('menu') or manifest.get('geometry', {}).get('menu')
    if source is None:
        rows = [(r['ratio'], r['ratio'], r['id']) for r in manifest['ratios']]
    else:
        rows = [(r['ratio'], r['name'], r['id']) for r in source]
        # The id/ratio list the hooks were built from must agree with the menu.
        assert [(r['ratio'], r['id']) for r in manifest['ratios']] == [(r, i) for r, _, i in rows]
    ids = [i for _, _, i in rows]
    assert len(ids) == len(set(ids))
    factory = sorted((r, i) for r, _, i in rows if i < FIRST)
    assert factory == [('1:1', 3), ('3:2', 0)], factory
    customs = sorted(i for i in ids if i >= FIRST)
    assert 1 <= len(customs) <= MAX_CUSTOM and customs == list(range(FIRST, FIRST + len(customs)))
    seen = set()
    for ratio, name, i in rows:
        assert re.fullmatch(r'[\x20-\x7e]{1,12}', name) and name == name.strip(), name
        if i >= FIRST:
            value = parse(ratio)
            assert Fraction(1, 2) <= value <= 3 and value not in (Fraction(3, 2), 1), ratio
            assert value not in seen; seen.add(value)
            assert value.numerator <= 65535 and value.denominator <= 65535
    return Menu(rows)

def is_t4(m):
    return [(r, i) for r, _, i in m.rows] == T4 and all(n == r for r, n, _ in m.rows)
