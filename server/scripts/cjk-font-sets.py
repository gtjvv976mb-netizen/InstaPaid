# Character sets for the card's CJK fallback fonts, from the national standards' encodings.
import sys
def decode_all(codec, lead, trail):
    out = set()
    for a in lead:
        for b in trail:
            try: s = bytes([a, b]).decode(codec)
            except UnicodeDecodeError: continue
            if len(s) == 1: out.add(ord(s))
    return out
han = lambda cps: {c for c in cps if 0x3400 <= c <= 0x9FFF or 0xF900 <= c <= 0xFAFF}
jis = decode_all('euc_jp', range(0xA1, 0xFF), range(0xA1, 0xFF))         # JIS X 0208
gb = decode_all('gb2312', range(0xA1, 0xFF), range(0xA1, 0xFF))           # GB2312
big5 = decode_all('big5', range(0xA4, 0xC7), list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)))  # Big5 level 1
ksx = decode_all('euc_kr', range(0xB0, 0xC9), range(0xA1, 0xFF))          # KS X 1001 Hangul
common = set(range(0x3000, 0x3040)) | set(range(0xFF01, 0xFF5F)) | set(range(0xFF61, 0xFFA0)) | set(range(0x30FB, 0x3100))
jp = han(jis) | set(range(0x3040, 0x3100)) | set(range(0x31F0, 0x3200)) | common
sc = han(gb) - jp
tc = han(big5) - jp - sc
kr = {c for c in ksx if 0xAC00 <= c <= 0xD7A3} | set(range(0x3130, 0x3190))
for name, s in [('jp', jp), ('sc', sc), ('tc', tc), ('kr', kr)]:
    open(f'{name}.txt', 'w').write(','.join(f'U+{c:04X}' for c in sorted(s)))
    print(name, len(s))
