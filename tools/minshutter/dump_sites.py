import json, struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from patchimg import patched
R = open(sys.argv[1], 'rb').read()
P, cdiff = patched(R)
B = 0x53000000
words = []
for a in range(0, len(R), 4):
    if R[a:a+4] != P[a:a+4]:
        words.append(dict(address=B + a, expected=R[a:a+4].hex(), replacement=P[a:a+4].hex()))
json.dump(dict(sites=words), open(sys.argv[2], 'w'), indent=1)
print(len(words), 'words differ')
