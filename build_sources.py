"""
Overture Maps (release 2026-09-23.1) buildings の sources[].dataset を使い、
首都圏の建物を「人が描いた (OpenStreetMap)」と「AIが見つけた
(Microsoft ML Buildings / East Asian Buildings)」に分けて集計する。

出力
  grid.js        約450mグリッドごとの出どころ別棟数
  footprints_*.js 注目エリアの建物フットプリント (出どころ付き)

  pip install pyarrow numpy
  python tools/build_sources.py
"""
import json, struct, sys
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import pyarrow.fs as fs
import pyarrow.parquet as pq

RELEASE = "2026-09-23.1"
BASE = f"overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/"
W, E, S, N = 139.10, 140.20, 35.30, 36.00
DX, DY = 0.005, 0.004
NX, NY = round((E - W) / DX), round((N - S) / DY)
SRC = {"OpenStreetMap": 0, "Microsoft ML Buildings": 1, "doi:10.5281/zenodo.8174931": 2}

# 建物の形まで描く注目エリア [id, 名前, W, S, E, N]
FEATURED = [
    ["fuchinobe", "淵野辺・青山学院大学 相模原キャンパス周辺", 139.375, 35.555, 139.410, 35.580],
]

s3 = fs.S3FileSystem(anonymous=True, region="us-west-2", request_timeout=60, connect_timeout=20)


def retry(fn):
    def wrap(*a):
        for i in range(4):
            try:
                return fn(*a)
            except Exception as e:  # ネットワークの一時的な失敗は再試行
                print("retry", i, e, file=sys.stderr, flush=True)
        raise RuntimeError("failed")
    return wrap


def groups(f, w, s, e, n):
    md = f.metadata
    idx = {md.schema.column(i).path: i for i in range(md.num_columns)}
    out = []
    for g in range(md.num_row_groups):
        r = md.row_group(g)
        st = lambda k: r.column(idx[k]).statistics
        if st("bbox.xmin").min > e or st("bbox.xmax").max < w or st("bbox.ymin").min > n or st("bbox.ymax").max < s:
            continue
        out.append(g)
    return out


def src_index(sources):
    if not sources:
        return 3
    return SRC.get(sources[0].get("dataset"), 3)


@retry
def grid_part(path):
    f = pq.ParquetFile(path, filesystem=s3)
    rgs = groups(f, W, S, E, N)
    if not rgs:
        return None
    t = f.read_row_groups(rgs, columns=["bbox", "sources"])
    bb = t.column("bbox").combine_chunks()
    cx = (bb.field("xmin").to_numpy() + bb.field("xmax").to_numpy()) / 2
    cy = (bb.field("ymin").to_numpy() + bb.field("ymax").to_numpy()) / 2
    ix = np.floor((cx - W) / DX).astype(np.int64)
    iy = np.floor((cy - S) / DY).astype(np.int64)
    ok = (ix >= 0) & (ix < NX) & (iy >= 0) & (iy < NY)
    if not ok.any():
        return None
    src = np.array([src_index(s) for s in t.column("sources").to_pylist()], dtype=np.int64)
    res = np.zeros(NY * NX * 4, dtype=np.int64)
    np.add.at(res, ((iy * NX + ix) * 4 + src)[ok], 1)
    return res


def parse_wkb(b):
    """Polygon / MultiPolygon の外周リングだけを取り出す"""
    rings = []
    def poly(off, le):
        fmt = "<" if le else ">"
        (nr,) = struct.unpack_from(fmt + "I", b, off); off += 4
        for r in range(nr):
            (npnt,) = struct.unpack_from(fmt + "I", b, off); off += 4
            pts = struct.unpack_from(fmt + "%dd" % (npnt * 2), b, off); off += 16 * npnt
            if r == 0:
                rings.append(list(zip(pts[0::2], pts[1::2])))
        return off
    le = b[0] == 1
    fmt = "<" if le else ">"
    (typ,) = struct.unpack_from(fmt + "I", b, 1)
    typ %= 1000
    if typ == 3:
        poly(5, le)
    elif typ == 6:
        (n,) = struct.unpack_from(fmt + "I", b, 5); off = 9
        for _ in range(n):
            le2 = b[off] == 1
            off = poly(off + 5, le2)
    return rings


@retry
def featured_part(args):
    path, (fid, name, w, s, e, n) = args
    f = pq.ParquetFile(path, filesystem=s3)
    rgs = groups(f, w, s, e, n)
    if not rgs:
        return []
    t = f.read_row_groups(rgs, columns=["bbox", "sources", "geometry", "num_floors", "height"]).to_pylist()
    out = []
    for r in t:
        b = r["bbox"]
        cx, cy = (b["xmin"] + b["xmax"]) / 2, (b["ymin"] + b["ymax"]) / 2
        if not (w <= cx <= e and s <= cy <= n):
            continue
        s0 = (r["sources"] or [{}])[0]
        year = (s0.get("update_time") or "")[:4]
        for ring in parse_wkb(r["geometry"]):
            out.append([src_index(r["sources"]), ring, int(year) if year.isdigit() else 0])
    return out


if __name__ == "__main__":
    import os
    files = [i.path for i in s3.get_file_info(fs.FileSelector(BASE)) if i.size > 0]
    cache = "/tmp/overture_source_grid.npy"
    if os.path.exists(cache):
        total = np.load(cache)
    else:
        total = np.zeros(NY * NX * 4, dtype=np.int64)
        with ThreadPoolExecutor(16) as ex:
            for k, r in enumerate(ex.map(grid_part, files)):
                if r is not None:
                    total += r
                if k % 50 == 0:
                    print(f"grid {k}/{len(files)}", file=sys.stderr, flush=True)
        np.save(cache, total)
    g = total.reshape(NY, NX, 4)
    cells = []
    for iy in range(NY):
        for ix in range(NX):
            c = g[iy, ix]
            if c[:3].sum() > 0:
                cells.append([ix, iy, int(c[0]), int(c[1]), int(c[2])])
    out = {
        "source": f"Overture Maps Foundation, release {RELEASE} — theme=buildings, sources[0].dataset",
        "bbox": [W, S, E, N], "dx": DX, "dy": DY, "nx": NX, "ny": NY,
        "fields": ["ix", "iy", "osm", "msft", "eab"], "cells": cells,
        "totals": {"osm": int(g[..., 0].sum()), "msft": int(g[..., 1].sum()), "eab": int(g[..., 2].sum())},
    }
    with open("grid.js", "w") as fp:
        fp.write("window.SOURCE_GRID=" + json.dumps(out, separators=(",", ":")) + ";\n")
    print("grid cells", len(cells), out["totals"], file=sys.stderr)

    for area in FEATURED:
        fid, name, w, s, e, n = area
        feats = []
        with ThreadPoolExecutor(16) as ex:
            for part in ex.map(featured_part, [(p, area) for p in files]):
                feats.extend(part)
        # 座標を 1e-5 度 (約1m) で量子化し、エリア南西端からの差分整数で保存
        enc = []
        for src, ring, year in feats:
            q = [(round((x - w) * 1e5), round((y - s) * 1e5)) for x, y in ring[:-1]]
            flat, px, py = [], 0, 0
            for x, y in q:
                flat += [x - px, y - py]; px, py = x, y
            enc.append([src, year, flat])
        data = {"id": fid, "name": name, "bbox": [w, s, e, n], "scale": 1e-5,
                "fields": ["src", "updateYear", "deltaRing"], "buildings": enc}
        with open(f"footprints_{fid}.js", "w") as fp:
            fp.write(f"window.FOOTPRINTS=window.FOOTPRINTS||{{}};window.FOOTPRINTS[{json.dumps(fid)}]=" +
                     json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
        print(fid, len(enc), file=sys.stderr)
