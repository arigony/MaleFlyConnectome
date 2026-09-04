#!/usr/bin/env python3
"""Build a local DNge104 connectivity subset from the public MaleCNS bulk tables.

No neuPrint token is required. The script downloads the official MaleCNS v1.0
segment-to-segment weight table and neuron annotations, filters all edges touching
seed body IDs, writes data/connectivity.json, and optionally caches top partner
SWCs so partner clicks work on GitHub Pages without CORS dependence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.feather as feather
import pyarrow.ipc as ipc

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SKEL_DIR = DATA_DIR / "skeletons"
CACHE_DIR = ROOT / ".cache" / "malecns"
DATA_DIR.mkdir(exist_ok=True)
SKEL_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

DATASET = "male-cns:v1.0"
BASE = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
WEIGHTS_NAME = "connectome-weights-male-cns-v1.0-minconf-0.5.feather"
ANNOT_NAME = "body-annotations-male-cns-v1.0-minconf-0.5.feather"
SWC_BASE = "https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/skeletons-malecns/skeletons-swc"


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"using cached {dest.name} ({dest.stat().st_size:,} bytes)")
        return
    tmp = dest.with_suffix(dest.suffix + ".part")
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "MaleFlyConnectome/0.3"})
    with urllib.request.urlopen(req, timeout=180) as r, tmp.open("wb") as f:
        total = int(r.headers.get("Content-Length", 0) or 0)
        done = 0
        while True:
            chunk = r.read(8 * 1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"  {done/total:6.1%}  {done/1024/1024:,.0f} MiB", flush=True)
    tmp.replace(dest)


def resolve(names: list[str], aliases: list[str]) -> str:
    lower = {n.lower(): n for n in names}
    for a in aliases:
        if a.lower() in lower:
            return lower[a.lower()]
    raise RuntimeError(f"Could not resolve any of {aliases} from columns: {names}")


def scalar_int(v) -> int:
    return int(v.as_py() if hasattr(v, "as_py") else v)


def scalar_text(v):
    if v is None:
        return None
    val = v.as_py() if hasattr(v, "as_py") else v
    if val is None:
        return None
    s = str(val).strip()
    return s or None


def filter_edges(weights_path: Path, seeds: set[int], min_weight: int) -> list[dict]:
    source = pa.memory_map(str(weights_path), "r")
    reader = ipc.open_file(source)
    names = reader.schema.names
    pre_col = resolve(names, ["bodyId_pre", "bodyid_pre", "pre", "pre_id", "body_pre"])
    post_col = resolve(names, ["bodyId_post", "bodyid_post", "post", "post_id", "body_post"])
    weight_col = resolve(names, ["weight", "total_weight", "syn_count", "count"])
    print("weight columns:", pre_col, post_col, weight_col)

    pre_i = reader.schema.get_field_index(pre_col)
    post_i = reader.schema.get_field_index(post_col)
    weight_i = reader.schema.get_field_index(weight_col)
    seed_pre = pa.array(sorted(seeds), type=reader.schema.field(pre_i).type)
    seed_post = pa.array(sorted(seeds), type=reader.schema.field(post_i).type)
    out: list[dict] = []

    for i in range(reader.num_record_batches):
        batch = reader.get_batch(i)
        pre = batch.column(pre_i)
        post = batch.column(post_i)
        weight = batch.column(weight_i)
        mask_seed = pc.or_(pc.is_in(pre, value_set=seed_pre), pc.is_in(post, value_set=seed_post))
        mask_weight = pc.greater_equal(weight, pa.scalar(min_weight, type=weight.type))
        mask = pc.and_(mask_seed, mask_weight)
        if not pc.any(mask).as_py():
            continue
        fpre = pc.filter(pre, mask)
        fpost = pc.filter(post, mask)
        fw = pc.filter(weight, mask)
        for j in range(len(fpre)):
            out.append({
                "bodyId_pre": scalar_int(fpre[j]),
                "bodyId_post": scalar_int(fpost[j]),
                "weight": scalar_int(fw[j]),
            })
        print(f"batch {i+1}/{reader.num_record_batches}: retained {len(out)} edges", flush=True)

    agg: dict[tuple[int, int], int] = defaultdict(int)
    for e in out:
        agg[(e["bodyId_pre"], e["bodyId_post"])] += e["weight"]
    return [
        {"bodyId_pre": pre, "bodyId_post": post, "weight": weight}
        for (pre, post), weight in agg.items()
    ]


def annotation_map(annotation_path: Path, body_ids: set[int]) -> dict[int, dict]:
    table = feather.read_table(annotation_path, memory_map=True)
    names = table.schema.names
    id_col = resolve(names, ["bodyId", "bodyid", "body", "segment_id", "segment"])
    try:
        type_col = resolve(names, ["type", "cell_type"])
    except RuntimeError:
        type_col = None
    try:
        instance_col = resolve(names, ["instance", "name"])
    except RuntimeError:
        instance_col = None

    ids = table[id_col]
    value_set = pa.array(sorted(body_ids), type=ids.type)
    subset = table.filter(pc.is_in(ids, value_set=value_set))
    result: dict[int, dict] = {}
    for row in subset.to_pylist():
        body_id = int(row[id_col])
        result[body_id] = {
            "type": scalar_text(row.get(type_col)) if type_col else None,
            "instance": scalar_text(row.get(instance_col)) if instance_col else None,
        }
    return result


def write_connectivity(edges: list[dict], info: dict[int, dict], seeds: set[int], min_weight: int) -> Path:
    enriched = []
    for e in sorted(edges, key=lambda x: (-x["weight"], x["bodyId_pre"], x["bodyId_post"])):
        pre = int(e["bodyId_pre"])
        post = int(e["bodyId_post"])
        pinfo = info.get(pre, {})
        qinfo = info.get(post, {})
        enriched.append({
            "bodyId_pre": str(pre),
            "bodyId_post": str(post),
            "weight": int(e["weight"]),
            "type_pre": pinfo.get("type"),
            "type_post": qinfo.get("type"),
            "instance_pre": pinfo.get("instance"),
            "instance_post": qinfo.get("instance"),
        })

    payload = {
        "schema_version": "1.1",
        "dataset": DATASET,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "query": {
            "seed_body_ids": [str(x) for x in sorted(seeds)],
            "minimum_source_weight": min_weight,
            "scope": "all neuron-to-neuron edges touching either DNge104 seed",
        },
        "edges": enriched,
        "provenance": {
            "weights": f"gs://flyem-male-cns/v1.0/connectome-data/flat-connectome/{WEIGHTS_NAME}",
            "annotations": f"gs://flyem-male-cns/v1.0/connectome-data/flat-connectome/{ANNOT_NAME}",
            "statement": "Filtered directly from the official MaleCNS v1.0 bulk connection graph; no generative model created or modified connectivity or weights.",
        },
    }
    out = DATA_DIR / "connectivity.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("wrote", out, "with", len(enriched), "edges")
    return out


def cache_partner_swcs(edges: list[dict], seeds: set[int], top_n: int) -> list[Path]:
    ranked: dict[int, int] = {}
    for e in edges:
        pre, post, weight = int(e["bodyId_pre"]), int(e["bodyId_post"]), int(e["weight"])
        for bid in (pre, post):
            if bid not in seeds:
                ranked[bid] = max(ranked.get(bid, 0), weight)
    partner_ids = [bid for bid, _ in sorted(ranked.items(), key=lambda kv: (-kv[1], kv[0]))[:top_n]]
    paths: list[Path] = []
    for i, bid in enumerate(partner_ids, 1):
        dest = SKEL_DIR / f"{bid}.swc"
        try:
            download(f"{SWC_BASE}/{bid}.swc", dest)
            paths.append(dest)
            print(f"partner skeleton {i}/{len(partner_ids)}: {bid}")
        except Exception as exc:
            print("warning: could not cache skeleton", bid, exc)
    return paths


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_manifest(files: list[Path], seeds: set[int]) -> None:
    unique = sorted({p.resolve() for p in files if p.exists()})
    payload = {
        "schema_version": "1.1",
        "dataset": DATASET,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "seed_body_ids": [str(x) for x in sorted(seeds)],
        "files": [
            {
                "path": str(p.relative_to(ROOT)).replace(os.sep, "/"),
                "bytes": p.stat().st_size,
                "sha256": sha256(p),
            }
            for p in unique
        ],
    }
    (DATA_DIR / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default="12781,556329")
    ap.add_argument("--min-weight", type=int, default=1)
    ap.add_argument("--partner-skeletons", type=int, default=32)
    args = ap.parse_args()
    seeds = {int(x.strip()) for x in args.seeds.split(",") if x.strip()}
    if not seeds:
        raise SystemExit("No seed IDs provided")
    if args.min_weight < 1:
        raise SystemExit("--min-weight must be >= 1")

    weights = CACHE_DIR / WEIGHTS_NAME
    annotations = CACHE_DIR / ANNOT_NAME
    download(f"{BASE}/{WEIGHTS_NAME}", weights)
    download(f"{BASE}/{ANNOT_NAME}", annotations)

    edges = filter_edges(weights, seeds, args.min_weight)
    body_ids = set(seeds)
    for e in edges:
        body_ids.add(int(e["bodyId_pre"]))
        body_ids.add(int(e["bodyId_post"]))
    info = annotation_map(annotations, body_ids)
    connectivity = write_connectivity(edges, info, seeds, args.min_weight)
    skeletons = cache_partner_swcs(edges, seeds, args.partner_skeletons)
    seed_skels = [SKEL_DIR / f"{bid}.swc" for bid in seeds]
    write_manifest([connectivity, *seed_skels, *skeletons], seeds)


if __name__ == "__main__":
    main()
