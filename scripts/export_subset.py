#!/usr/bin/env python3
"""Export a scientifically traceable MaleCNS subset for the static AR frontend.

Examples
--------
PowerShell::

    $env:NEUPRINT_APPLICATION_CREDENTIALS="YOUR_TOKEN"
    python scripts/export_subset.py --type DNge104 --min-weight 1 --max-partners 0 --partner-skeletons 24

bash::

    export NEUPRINT_APPLICATION_CREDENTIALS="YOUR_TOKEN"
    python scripts/export_subset.py --type DNge104 --min-weight 1 --max-partners 0 --partner-skeletons 24

The token is used only during export and is never written to frontend files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from neuprint import Client, NeuronCriteria as NC, fetch_adjacencies, fetch_neurons

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
OUT_SKELS = DATA_DIR / "skeletons"
OUT_SKELS.mkdir(parents=True, exist_ok=True)
DATASET = "male-cns:v1.0"
SERVER = "https://neuprint.janelia.org"
MALECNS_DOWNLOAD = "https://male-cns.janelia.org/download/"


def clean(value: Any) -> Any:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value.item() if hasattr(value, "item") else value


def label_from_row(row: pd.Series) -> str:
    return str(clean(row.get("instance")) or clean(row.get("type")) or int(row["bodyId"]))


def skeleton_to_json(client: Client, body_id: int, label: str) -> dict[str, Any]:
    df = client.fetch_skeleton(body_id, format="pandas")
    required = ["rowId", "x", "y", "z", "radius", "link"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise RuntimeError(f"Skeleton {body_id} missing columns: {missing}")
    rows = df[required].rename(columns={"rowId": "id", "radius": "r", "link": "parent"}).copy()
    rows.insert(1, "type", 0)
    return {
        "bodyId": str(body_id),
        "label": label,
        "dataset": DATASET,
        "coordinate_space": "MaleCNS EM skeleton coordinates",
        "source_units": "8 nm units",
        "source": "neuPrint Client.fetch_skeleton(format='pandas')",
        "nodes": rows.to_dict(orient="records"),
    }


def write_json(path: Path, payload: Any, *, compact: bool = False) -> None:
    if compact:
        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    else:
        text = json.dumps(payload, indent=2, ensure_ascii=False)
    path.write_text(text + ("" if compact else "\n"), encoding="utf-8")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_direction(client: Client, seed_ids: list[int], direction: str, min_weight: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    kwargs = dict(
        min_total_weight=min_weight,
        omit_rois=True,
        weight_props=["weight"],
        client=client,
    )
    if direction == "outgoing":
        neuron_df, conn_df = fetch_adjacencies(NC(bodyId=seed_ids), None, **kwargs)
    elif direction == "incoming":
        neuron_df, conn_df = fetch_adjacencies(None, NC(bodyId=seed_ids), **kwargs)
    else:
        raise ValueError(direction)
    return neuron_df, conn_df


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", default="DNge104", help="MaleCNS neuron type used as the seed set")
    ap.add_argument("--min-weight", type=int, default=1, help="Server-side minimum total connection weight")
    ap.add_argument("--max-partners", type=int, default=0, help="Maximum number of seed-adjacent edges retained; 0 keeps all")
    ap.add_argument("--partner-skeletons", type=int, default=24, help="Also export skeletons for the top N partner neurons; 0 disables")
    args = ap.parse_args()

    if args.min_weight < 1:
        raise SystemExit("--min-weight must be >= 1")
    if args.max_partners < 0 or args.partner_skeletons < 0:
        raise SystemExit("--max-partners and --partner-skeletons must be >= 0")

    token = os.environ.get("NEUPRINT_APPLICATION_CREDENTIALS")
    if not token:
        raise SystemExit("Set NEUPRINT_APPLICATION_CREDENTIALS with your neuPrint token.")

    client = Client(SERVER, dataset=DATASET, token=token)
    seeds, _ = fetch_neurons(NC(type=args.type, regex=False), omit_rois=True, client=client)
    if seeds.empty:
        raise SystemExit(f"No neurons found for type {args.type!r}")

    seed_ids = [int(x) for x in seeds.bodyId.tolist()]
    seed_labels = {int(row.bodyId): label_from_row(row) for _, row in seeds.iterrows()}

    exported_skeleton_paths: list[Path] = []
    for body_id in seed_ids:
        payload = skeleton_to_json(client, body_id, seed_labels[body_id])
        path = OUT_SKELS / f"{body_id}.json"
        write_json(path, payload, compact=True)
        exported_skeleton_paths.append(path)
        print("wrote seed skeleton", body_id, seed_labels[body_id])

    out_neurons, outgoing = fetch_direction(client, seed_ids, "outgoing", args.min_weight)
    in_neurons, incoming = fetch_direction(client, seed_ids, "incoming", args.min_weight)
    edges = pd.concat([outgoing, incoming], ignore_index=True)
    if edges.empty:
        edges = pd.DataFrame(columns=["bodyId_pre", "bodyId_post", "weight"])
    else:
        edges = edges[["bodyId_pre", "bodyId_post", "weight"]].drop_duplicates(["bodyId_pre", "bodyId_post"])
        edges = edges.sort_values(["weight", "bodyId_pre", "bodyId_post"], ascending=[False, True, True])
        if args.max_partners:
            edges = edges.head(args.max_partners)

    all_neurons = pd.concat([seeds, out_neurons, in_neurons], ignore_index=True).drop_duplicates("bodyId")
    info_map = {int(row.bodyId): row.to_dict() for _, row in all_neurons.iterrows()}

    exported_edges = []
    for _, edge in edges.iterrows():
        pre, post = int(edge.bodyId_pre), int(edge.bodyId_post)
        pre_info, post_info = info_map.get(pre, {}), info_map.get(post, {})
        exported_edges.append({
            "bodyId_pre": str(pre),
            "bodyId_post": str(post),
            "weight": int(edge.weight),
            "type_pre": clean(pre_info.get("type")),
            "type_post": clean(post_info.get("type")),
            "instance_pre": clean(pre_info.get("instance")),
            "instance_post": clean(post_info.get("instance")),
        })

    connectivity = {
        "schema_version": "1.0",
        "dataset": DATASET,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "query": {
            "seed_type": args.type,
            "seed_body_ids": [str(x) for x in seed_ids],
            "min_total_weight": args.min_weight,
            "max_edges": args.max_partners or None,
        },
        "edges": exported_edges,
        "provenance": {
            "server": SERVER,
            "male_cns_download": MALECNS_DOWNLOAD,
            "method": "neuprint-python fetch_adjacencies(..., omit_rois=True, weight_props=['weight'])",
            "statement": "Neuron-to-neuron edges and weights were exported from neuPrint; no generative model created or modified connectivity.",
        },
    }
    connectivity_path = DATA_DIR / "connectivity.json"
    write_json(connectivity_path, connectivity)
    print("wrote connectivity", len(exported_edges), "edges")

    partner_ids: list[int] = []
    if args.partner_skeletons and exported_edges:
        seed_set = set(seed_ids)
        ranked: dict[int, int] = {}
        for edge in exported_edges:
            pre, post, weight = int(edge["bodyId_pre"]), int(edge["bodyId_post"]), int(edge["weight"])
            for body_id in (pre, post):
                if body_id not in seed_set:
                    ranked[body_id] = max(ranked.get(body_id, 0), weight)
        partner_ids = [body_id for body_id, _ in sorted(ranked.items(), key=lambda kv: (-kv[1], kv[0]))[: args.partner_skeletons]]
        for body_id in partner_ids:
            info = info_map.get(body_id, {})
            label = str(clean(info.get("instance")) or clean(info.get("type")) or body_id)
            path = OUT_SKELS / f"{body_id}.json"
            try:
                write_json(path, skeleton_to_json(client, body_id, label), compact=True)
                exported_skeleton_paths.append(path)
                print("wrote partner skeleton", body_id, label)
            except Exception as exc:
                print("warning: could not export skeleton", body_id, exc)

    data_files = [connectivity_path] + sorted(set(exported_skeleton_paths))
    manifest = {
        "schema_version": "1.0",
        "dataset": DATASET,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "seed_type": args.type,
        "seed_body_ids": [str(x) for x in seed_ids],
        "partner_skeletons_requested": args.partner_skeletons,
        "partner_body_ids_selected": [str(x) for x in partner_ids],
        "files": [
            {
                "path": str(path.relative_to(ROOT)).replace("\\", "/"),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for path in data_files
        ],
    }
    write_json(DATA_DIR / "manifest.json", manifest)
    print("wrote manifest with", len(manifest["files"]), "hashed data files")


if __name__ == "__main__":
    main()
