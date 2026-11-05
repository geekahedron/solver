# Builds the built-in English packs from ENABLE (public domain), ranked by Norvig's count_1w.txt frequencies.
import re, os
en=[w.strip().lower() for w in open('/tmp/enable1.txt')]
S=set(en)
freq={}
for line in open('/tmp/count_1w.txt'):
    w,c=line.split('\t'); freq[w]=int(c)
def inflected(w):
    if w.endswith('s') and not w.endswith('ss') and (w[:-1] in S or (w.endswith('es') and w[:-2] in S)): return True
    if w.endswith('ed') and (w[:-2] in S or w[:-1] in S): return True
    return False
BAD=set(open('/tmp/bad.txt').read().split()) if os.path.exists('/tmp/bad.txt') else set()
NANS={4:1500,5:2400,6:2600,7:2600,8:2400}
for L,na in NANS.items():
    allw=sorted({w for w in en if re.fullmatch('[a-z]{%d}'%L,w)})
    cands=[w for w in allw if not inflected(w) and w in freq and w not in BAD]
    cands.sort(key=lambda w:-freq[w])
    ans=sorted(cands[:na])
    open('src/packs/english%d-answers.txt'%L,'w').write('\n'.join(ans)+'\n')
    open('src/packs/english%d-guesses.txt'%L,'w').write('\n'.join(allw)+'\n')
    print(L,len(allw),len(ans),cands[na-5:na])
