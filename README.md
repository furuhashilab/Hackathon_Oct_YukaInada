# 人が描いた街、AIが見つけた街 — Overture Maps × GeoAI

Overture Maps の建物データを「出どころ」で色分けし、OpenStreetMap のボランティアが**手で描いた建物**と、AI が衛星画像から**自動で見つけた建物**を比べる Web マップです。
SotM Asia 2026 Osaka で紹介された Overture Maps と GeoAI を、首都圏のデータで実際に使ってみました。

**▶ デモ:** https://furuhashilab.github.io/Hackathon_Oct_YukaInada/

## わかったこと（首都圏 約818万棟）

| 出どころ | 種類 | 棟数 | 割合 |
|---|---|---:|---:|
| OpenStreetMap | 人が描いた | 5,369,157 | 65.6% |
| Microsoft ML Buildings | AI（衛星画像から抽出） | 2,381,293 | 29.1% |
| East Asian Buildings (doi:10.5281/zenodo.8174931) | AI（衛星画像から抽出） | 432,890 | 5.3% |

- 首都圏の建物の約3分の1は、OSM ではなく AI 由来のデータで補われています。
- 淵野辺駅の半径1kmでは AI 由来は 8.8% と少なく、OSM のマッピングが進んでいます。
- 足立区・江戸川区・市川市・草加市などには、AI 由来が9割を超える場所があり、OSM の編集候補になります。

## 機能

1. **出どころ別の建物マップ** — 1棟を1点として、人が描いた建物を青、AI が見つけた建物をマゼンタで表示（ドット表示 / 約450mマスごとの AI 比率表示）
2. **地名・駅名検索** — 「淵野辺」「ふちのべ」のように漢字でもひらがなでも検索でき、その場所の半径1kmの内訳（人 / AI）、首都圏平均との比較、OSM 編集候補度を表示
3. **OSM 編集候補ランキング** — AI だけが見つけた建物が多い場所トップ10。iD エディタや Overture Explorer へのリンク付き
4. **目印のピン** — 駅・大学・病院・市区役所・商業施設・学校・公園・スーパー・コンビニを Overture places から約2.9万件。ズームに応じて表示し、重なるピンは間引きます。大学などは施設名でも検索できます
5. **建物の形（淵野辺周辺）** — 青山学院大学 相模原キャンパス周辺は建物1棟ずつの形を表示。クリックで出どころと OSM の最終編集年がわかります

## Overture Maps の使いどころ

| テーマ | 使い方 |
|---|---|
| `buildings` | 各建物の `sources[0].dataset` で OSM / AI 由来を判定して集計・色分け |
| `divisions` | 町丁目・市区町村の名前と位置、階層（所属市区町村）、ひらがな読み（`names.common["ja-Hira"]`）を検索とエリア名に使用 |
| `places` | 駅名検索と目印のピン（`basic_category` と `confidence` で選別。名前の地名と位置が10km以上離れた投稿などは除外） |

Overture は OpenStreetMap の建物を優先し、OSM に建物がない場所を AI 由来の建物で補っています。そのため AI 由来の建物が多い場所は、OSM にまだ描かれていない建物が多い場所といえます。

## ファイル構成

```
index.html                画面レイアウト（Tailwind CSS）
style.css                 ダークUIのスタイル
app.js                    Leaflet マップ・検索・ピン・レポート
grid.js                   出どころ別の棟数グリッド（約450m）
search.js                 地名・駅名の検索インデックス（読みがな付き）
landmarks.js              目印のピン（施設）
footprints_fuchinobe.js   淵野辺周辺の建物フットプリント
build_sources.py          Overture buildings の集計スクリプト
build_search.py           Overture divisions / places の検索インデックス作成
build_landmarks.py        Overture places から目印の施設を抽出
```

`index.html` をブラウザで開くだけで動きます（ビルド不要）。データを作り直すときは `pip install pyarrow numpy pykakasi` のあと `python build_sources.py`、`python build_search.py`、`python build_landmarks.py` を実行します（Overture の S3 から匿名で読み込み）。

Data © Overture Maps Foundation (release 2026-09-23.1) · © OpenStreetMap contributors (ODbL) · Microsoft ML Buildings (ODbL) · East Asian Buildings (doi:10.5281/zenodo.8174931) · 背景地図: 国土地理院 淡色地図
