"""
地図の目印になる施設を Overture Maps places (release 2026-09-23.1) から抽出する。
  大学・病院・市区役所・大型商業施設 (広域で表示) / 学校・公園・スーパー / コンビニ (近くで表示)
出力: landmarks.js   [lng, lat, 名前, 種類, 読みがな]

  pip install pyarrow pykakasi
  python tools/build_landmarks.py
"""
import json, math, re, sys, collections
import pyarrow.fs as fs, pyarrow.parquet as pq
import pykakasi

KAKASI = pykakasi.kakasi()

RELEASE = "2026-09-23.1"
W, E, S, N = 139.10, 140.20, 35.30, 36.00
s3 = fs.S3FileSystem(anonymous=True, region="us-west-2", request_timeout=60, connect_timeout=20)

# 種類: 0 大学 / 1 病院 / 2 市区役所 / 3 大型商業施設 / 4 学校 / 5 公園 / 6 スーパー / 7 コンビニ
def classify(cat, name, conf):
    if not cat or not name:
        return None
    if cat == "college_university" and conf >= 0.8 and re.search("大学(?!院)|キャンパス", name) and not re.search("部|サークル|研究室|センター|病院|クリニック|寮", name):
        return 0
    if cat == "hospital" and conf >= 0.8 and name.endswith(("病院", "医療センター")):
        return 1
    if cat in ("government_office", "community_and_government", "city_hall", "town_hall") and conf >= 0.8 and re.search("(市役所|区役所|町役場|村役場)$", name):
        return 2
    if cat in ("shopping_mall", "shopping_center", "department_store", "outlet_store") and conf >= 0.8:
        return 3
    if cat in ("elementary_school", "high_school", "middle_school") and conf >= 0.8 and name.endswith(("小学校", "中学校", "高等学校", "高校", "学園")):
        return 4
    if cat == "park" and conf >= 0.85 and name.endswith(("公園", "緑地", "庭園")):
        return 5
    if cat in ("supermarket", "grocery_store", "food_and_beverage_store") and conf >= 0.8 and re.search("スーパー|イオン|イトーヨーカドー|ライフ|西友|オーケー|マルエツ|サミット|いなげや|ヤオコー|ベルク|業務スーパー|まいばすけっと|コープ|相鉄ローゼン|東急ストア|成城石井|ドン・キホーテ|ロピア|ベイシア|オオゼキ|三和|マルエツ", name):
        return 6
    if cat == "convenience_store" and conf >= 0.75 and not re.search("ATM|銀行|出張所", name):
        return 7
    return None


def km(a, b):
    return math.hypot((a[0] - b[0]) * 90.5, (a[1] - b[1]) * 110.9)


rows, cats = [], collections.Counter()
paths = [x.path for x in s3.get_file_info(fs.FileSelector(f"overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/")) if x.size > 0]
for p in paths:
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
        if not (W <= x <= E and S <= y <= N):
            continue
        name = ((nm or {}).get("primary") or "").strip()
        k = classify(cat, name, conf or 0)
        if k is None:
            continue
        cats[k] += 1
        rows.append([x, y, name, k, conf or 0])
    print(p.split("/")[-1][:20], len(rows), file=sys.stderr, flush=True)

# 名前に市区名を含むのに、その市区から遠く離れた施設は位置ずれとみなして除く
# (例: 渋谷区に登録された「横浜赤レンガ倉庫」)
idx = json.loads(open("search.js").read().split("=", 1)[1].rstrip().rstrip(";"))
cities = {}
for e in idx["entries"]:
    if e[4] == 0:
        key = re.sub("[市区町村]$", "", e[2])
        if len(key) >= 2:
            cities.setdefault(key, []).append((e[0], e[1]))
def misplaced(x, y, name):
    for key, pts in cities.items():
        if key in name and min(km((x, y), q) for q in pts) > 10:
            return True
    return False
before = len(rows)
rows = [r for r in rows if not misplaced(r[0], r[1], r[2])]
print("misplaced removed", before - len(rows), file=sys.stderr)

# 同じ名前・近い位置 (大学は1km, ほかは150m) の重複をまとめる
rows.sort(key=lambda r: -r[4])
grid = collections.defaultdict(list)
kept = []
for x, y, name, k, conf in rows:
    base = re.sub(r"\s.*$", "", name) if k == 0 else name
    gx, gy = int(x / 0.01), int(y / 0.01)
    lim = 1.0 if k == 0 else 0.15
    dup = False
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for o in grid[(gx + dx, gy + dy)]:
                if o[3] == k and (o[2] == base or (k == 7 and km((x, y), o) < 0.03)) and km((x, y), o) < lim:
                    dup = True
    if dup:
        continue
    item = [round(x, 5), round(y, 5), base, k]
    if k <= 3:  # 大学・病院・役所・商業施設は施設名検索用に読みがなを付ける
        item.append("".join(w["hira"] for w in KAKASI.convert(base)))
    grid[(gx, gy)].append(item)
    kept.append(item)

out = {"source": f"Overture Maps Foundation, release {RELEASE} — places (basic_category, confidence)",
       "fields": ["lng", "lat", "name", "kind", "reading(kind<=3)"],
       "kinds": ["大学", "病院", "市区役所", "商業施設", "学校", "公園", "スーパー", "コンビニ"],
       "places": kept}
with open("landmarks.js", "w") as fp:
    fp.write("window.LANDMARKS=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
print("raw", dict(cats), "kept", collections.Counter(r[3] for r in kept), file=sys.stderr)
