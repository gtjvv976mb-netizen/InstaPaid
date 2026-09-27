# Card fonts

The auto-poster's card (`src/card.js`) is drawn with these files only, so it looks the same on any
host, including one with no fonts installed. All are under the SIL Open Font License 1.1; each
license is beside its font.

| File | What it draws | Source |
|---|---|---|
| `Inter_800ExtraBold.ttf` | the `$TICKER` | Inter, `@expo-google-fonts/inter` (`LICENSE_FONT`) |
| `Inter_600SemiBold.ttf` | the name, "for @creator", the claim line (Latin, Greek, Cyrillic, Vietnamese) | same |
| `NotoSansJP_600SemiBold-subset.ttf` | Japanese kana, the JIS X 0208 kanji, CJK punctuation, full-width forms | Noto Sans JP 600, `@expo-google-fonts/noto-sans-jp` (`LICENSE_NOTO_CJK`) |
| `NotoSansSC_600SemiBold-subset.ttf` | the GB 2312 hanzi not already in the JP subset | Noto Sans SC 600 (`LICENSE_NOTO_CJK`) |
| `NotoSansTC_600SemiBold-subset.ttf` | the Big5 level-1 hanzi not in the two above | Noto Sans TC 600 (`LICENSE_NOTO_CJK`) |
| `NotoSansKR_600SemiBold-subset.ttf` | the KS X 1001 Hangul syllables and the compatibility jamo | Noto Sans KR 600 (`LICENSE_NOTO_CJK`) |
| `NotoSansArabic_600SemiBold.ttf`, `NotoSansHebrew_600SemiBold.ttf`, `NotoSansThai_600SemiBold.ttf`, `NotoSansDevanagari_600SemiBold.ttf` | those scripts, whole fonts | Noto Sans 600 (`LICENSE_NOTO_*`) |

The CJK fonts are cut down to the characters of each national standard so the four weigh about
4 MB instead of 30. A name with a character none of these fonts has is left off the card (the
ticker and "for @creator" stay), never drawn as empty boxes.

To make the subsets again (Python with fonttools: `pip install fonttools`):

```sh
python3 scripts/cjk-font-sets.py          # writes jp.txt, sc.txt, tc.txt, kr.txt
for S in JP SC TC KR; do
  pyftsubset NotoSans${S}_600SemiBold.ttf --unicodes-file=$(echo $S | tr A-Z a-z).txt \
    --output-file=assets/fonts/NotoSans${S}_600SemiBold-subset.ttf \
    --no-hinting --desubroutinize --name-IDs='*' --name-legacy --name-languages='*'
done
```
