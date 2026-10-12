"""
地名検索用インデックスを Overture Maps (release 2026-09-23.1) から作る。
  - divisions: 町丁目 (neighborhood/microhood) と市区町村 (locality) の代表点と所属市区町村
  - places   : 駅 (basic_category に station を含むもの) の位置と名前
読みがな: divisions の names.common["ja-Hira"] を優先し、無いものは pykakasi で補う
出力: search.js

  pip install pyarrow pykakasi
"""
import json, re
import pyarrow.fs as fs, pyarrow.parquet as pq
import pykakasi

KAKASI = pykakasi.kakasi()
NUM_READ = "(?:[0-9０-９一二三四五六七八九十]|いっ|いち|に|さん|よん|し|ご|ろっ|ろく|なな|しち|はっ|はち|きゅう|く|じゅっ|じゅう)+ちょうめ$"


def reading(name, common=None):
    """ひらがな読み。Overture の ja-Hira があれば使い、無ければ pykakasi で変換"""
    com = dict(common or [])
    r = com.get("ja-Hira")
    if r:
        return re.sub(NUM_READ, "", r)
    name = re.sub(r"[一二三四五六七八九十0-9０-９]+丁目$", "", name)
    return "".join(x["hira"] for x in KAKASI.convert(name))

RELEASE = "2026-09-23.1"
W, E, S, N = 139.10, 140.20, 35.30, 36.00
s3 = fs.S3FileSystem(anonymous=True, region="us-west-2")
CHOME = "[一二三四五六七八九十0-9０-９]+丁目$"
SKIP = ("広場", "公園", "通り", "ビル", "タワー", "番", "地区")


def ls(t):
    return [x.path for x in s3.get_file_info(fs.FileSelector(f"overturemaps-us-west-2/release/{RELEASE}/{t}/")) if x.size > 0]


def ward_of(hier):
    if not hier:
        return None
    h = hier[0]
    loc = next((d["name"] for d in h if d["subtype"] == "locality" and not d["name"].isascii()), None)
    macro = next((d["name"] for d in h if d["subtype"] == "macrohood" and d["name"].endswith("区")), None)
    if loc and macro and loc.endswith("市"):
        return loc + macro
    return loc or macro


entries, seen = [], set()
# kind: 0=市区町村 1=町名 2=駅
for p in ls("theme=divisions/type=division"):
    t = pq.read_table(p, filesystem=s3, columns=["subtype", "names", "hierarchies", "bbox", "country"],
                      filters=[("country", "=", "JP")])
    bb = t.column("bbox").combine_chunks()
    for st, nm, hier, x, y in zip(t.column("subtype").to_pylist(), t.column("names").to_pylist(),
                                  t.column("hierarchies").to_pylist(),
                                  bb.field("xmin").to_pylist(), bb.field("ymin").to_pylist()):
        if not (W <= x <= E and S <= y <= N):
            continue
        name = (nm or {}).get("primary") or ""
        if st == "locality" and not name.isascii() and re.search("[市区町村]$", name):
            ward = ward_of(hier)
            label = name
            kind = 0
        elif st in ("neighborhood", "microhood"):
            ward = ward_of(hier)
            label = re.sub(CHOME, "", name)
            label = re.sub(r"[（(].*?[)）]", "", label)
            kind = 1
            if len(label) < 2 or any(w in label for w in SKIP) or label.endswith("丁目"):
                continue
        else:
            continue
        key = (kind, label, ward)
        if key in seen:
            continue
        seen.add(key)
        entries.append([round(x, 4), round(y, 4), label, ward or "", kind,
                        reading(label if kind == 1 else name, (nm or {}).get("common") if kind == 0 or label == name or re.sub(CHOME, "", name) == label else None)])

# 駅: Overture places には位置のずれた投稿も混ざるため、
#   (1) 路線名などを除いた駅名 (例: "JR 山手線渋谷駅" → "渋谷") を作り、
#   (2) 同じ名前の町名・市区町村が近く (4km以内) にあるか、そもそも同名の町が無い駅だけを残し、
#   (3) 同じ駅名は1件にまとめる (同名の町から2km以内なら町に近いもの、無ければ confidence が最も高いもの)
import math
LINE = re.compile(r"^(.*?)(?:線|ライン|メトロ|東日本|鉄道|電鉄|モノレール|Jr|JR)\s*")
def station_base(name):
    b = re.sub("駅$", "", name.split(" ")[-1])
    while True:
        m = LINE.match(b)
        if not m or not b[m.end():]:
            break
        b = b[m.end():]
    for pre in ("小田急", "京王", "東急", "西武", "東武", "京急", "京成", "相鉄", "都営", "東京メトロ", "つくばエクスプレス"):
        if b.startswith(pre) and len(b) > len(pre) + 1:
            b = b[len(pre):]
    return b

towns_by_name = {}
for e in entries:
    for key in {e[2], re.sub("[市区町村]$", "", e[2])}:
        towns_by_name.setdefault(key, []).append((e[0], e[1]))

def km(a, b):
    return math.hypot((a[0] - b[0]) * 90.5, (a[1] - b[1]) * 110.9)

stations = []
for p in ls("theme=places/type=place"):
    f = pq.ParquetFile(p, filesystem=s3)
    md = f.metadata
    idx = {md.schema.column(i).path: i for i in range(md.num_columns)}
    rgs = [g for g in range(md.num_row_groups)
           if not (md.row_group(g).column(idx["bbox.xmin"]).statistics.min > E
                   or md.row_group(g).column(idx["bbox.xmax"]).statistics.max < W
                   or md.row_group(g).column(idx["bbox.ymin"]).statistics.min > N
                   or md.row_group(g).column(idx["bbox.ymax"]).statistics.max < S)]
    if not rgs:
        continue
    t = f.read_row_groups(rgs, columns=["bbox", "names", "basic_category", "confidence"])
    bb = t.column("bbox").combine_chunks()
    for x, y, nm, cat, conf in zip(bb.field("xmin").to_pylist(), bb.field("ymin").to_pylist(),
                                   t.column("names").to_pylist(), t.column("basic_category").to_pylist(),
                                   t.column("confidence").to_pylist()):
        if not (W <= x <= E and S <= y <= N) or not cat or "station" not in cat:
            continue
        if not any(k in cat for k in ("train", "subway", "railway", "metro")):
            continue
        name = (nm or {}).get("primary") or ""
        if not name.endswith("駅") or name.isascii() or re.search("最寄|から|徒歩|付近|周辺", name):
            continue
        base = station_base(name)
        if len(base) < 1:
            continue
        same = towns_by_name.get(base, [])
        if same and min(km((x, y), t2) for t2 in same) > 4:
            continue  # 同名の町が別の場所にある → 位置ずれの可能性が高い
        stations.append([x, y, base, conf or 0])

# 同名の町 (町丁目) があれば、その町から2km以内の候補のうち confidence が最も高いものを選ぶ
town_pts = {}
for e in entries:
    if e[4] == 1:
        town_pts.setdefault(e[2], []).append((e[0], e[1]))
groups_ = {}
for st in stations:
    groups_.setdefault(st[2], []).append(st)
kept = []
for base, cands in groups_.items():
    same = town_pts.get(base, [])
    if same:
        d = lambda c: min(km((c[0], c[1]), t2) for t2 in same)
        near = [c for c in cands if d(c) <= 2]
        if near:  # 0.5km刻みで町に近い順、同じなら confidence 順
            kept.append(min(near, key=lambda c: (round(d(c) * 2) / 2, -c[3])))
            continue
    kept.append(max(cands, key=lambda c: c[3]))
for x, y, base, conf in kept:
    entries.append([round(x, 4), round(y, 4), base + "駅", "", 2, reading(base) + "えき"])

out = {"source": f"Overture Maps Foundation, release {RELEASE} — divisions (町名・市区町村), places (駅)",
       "fields": ["lng", "lat", "name", "ward", "kind", "reading"], "entries": entries}
with open("search.js", "w") as fp:
    fp.write("window.SEARCH_INDEX=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
import collections
print(len(entries), collections.Counter(e[4] for e in entries))
print([e for e in entries if "淵野辺" in e[2]][:10])
print(sum(1 for e in entries if e[5]), "readings")
