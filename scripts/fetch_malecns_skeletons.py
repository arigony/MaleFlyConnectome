#!/usr/bin/env python3
"""Fetch MaleCNS v1.0 SWC skeletons for reproducible LOD preprocessing."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

DATASET = "male-cns:v1.0"
ANNOTATIONS_URL = (
    "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/"
    "flat-connectome/body-annotations-male-cns-v1.0-minconf-0.5.feather"
)
SWC_BASE = (
    "https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/"
    "skeletons-malecns/skeletons-swc/"
)

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def download(url: str, path: Path, timeout: int = 60, retries: int = 3) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return
    tmp = path.with_suffix(path.suffix + ".part")
    last_error = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "MaleFlyConnectome/0.4 research-pipeline"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp, tmp.open("wb") as out:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            tmp.replace(path)
            return
        except Exception as exc:
            last_error = exc
            tmp.unlink(missing_ok=True)
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to download {url}: {last_error}")

def detect_column(df: pd.DataFrame, candidates: list[str], required: bool = True):
    lower = {str(c).lower(): str(c) for c in df.columns}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    if required:
        raise KeyError(
            f"Could not find any of {candidates}; available columns include: "
            + ", ".join(map(str, df.columns[:30]))
        )
    return None

def normalize_body_id(value) -> str:
    if pd.isna(value):
        raise ValueError("Missing body ID")
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError(f"Non-integral body ID {value}")
        return str(int(value))
    text = str(value).strip()
    if text.endswith(".0") and text[:-2].isdigit():
        text = text[:-2]
    if not text.isdigit():
        raise ValueError(f"Unexpected body ID {value!r}")
    return text

def select_rows(df: pd.DataFrame, args):
    body_col = detect_column(df, ["body", "bodyId", "bodyid", "body_id", "segment_id"])
    type_col = detect_column(df, ["type", "cell_type", "celltype"], required=False)
    selected = df.copy()
    mode = "all-annotated"

    if args.body_ids:
        wanted = {x.strip() for x in args.body_ids.split(",") if x.strip()}
        normalized = selected[body_col].map(
            lambda x: normalize_body_id(x) if not pd.isna(x) else ""
        )
        selected = selected[normalized.isin(wanted)]
        mode = "explicit-body-ids"

    if args.type_regex:
        if type_col is None:
            raise SystemExit("--type-regex requested, but no type column was found")
        pattern = re.compile(args.type_regex)
        selected = selected[
            selected[type_col].fillna("").astype(str).map(
                lambda s: bool(pattern.search(s))
            )
        ]
        mode = "type-regex"

    if args.one_per_type:
        if type_col is None:
            raise SystemExit("--one-per-type requested, but no type column was found")
        selected = selected[selected[type_col].notna()].copy()
        selected["_body_norm"] = selected[body_col].map(normalize_body_id)
        selected["_body_numeric"] = selected["_body_norm"].map(int)
        selected = (
            selected.sort_values([type_col, "_body_numeric"])
            .groupby(type_col, sort=True, as_index=False)
            .head(1)
        )
        mode = "one-deterministic-body-per-annotated-type"

    if args.limit and args.limit > 0:
        selected = selected.head(args.limit)

    selected = selected.copy()
    selected["_body_norm"] = selected[body_col].map(normalize_body_id)
    meta = {
        "selection_mode": mode,
        "body_column": body_col,
        "type_column": type_col,
        "selected_rows": len(selected),
        "note": (
            "For --one-per-type the smallest numeric body ID per annotated type is "
            "selected deterministically. It is not claimed to be a canonical "
            "biological representative."
        ),
    }
    return selected, meta

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="data/skeletons-global")
    parser.add_argument("--cache", default=".cache/malecns")
    parser.add_argument("--body-ids", default="")
    parser.add_argument("--type-regex", default="")
    parser.add_argument("--one-per-type", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    annotations = cache / "body-annotations-male-cns-v1.0-minconf-0.5.feather"
    download(ANNOTATIONS_URL, annotations, timeout=max(args.timeout, 120))
    df = pd.read_feather(annotations)
    selected, selection_meta = select_rows(df, args)
    body_ids = list(dict.fromkeys(selected["_body_norm"].tolist()))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    successes, failures = [], []

    def task(body_id: str):
        dest = output / f"{body_id}.swc"
        download(f"{SWC_BASE}{body_id}.swc", dest, timeout=args.timeout)
        return {
            "bodyId": body_id,
            "path": dest.as_posix(),
            "bytes": dest.stat().st_size,
            "sha256": sha256_file(dest),
        }

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(task, body_id): body_id for body_id in body_ids}
        for i, future in enumerate(as_completed(futures), start=1):
            body_id = futures[future]
            try:
                successes.append(future.result())
            except Exception as exc:
                failures.append({"bodyId": body_id, "error": str(exc)})
            if i % 100 == 0 or i == len(futures):
                print(
                    f"{i}/{len(futures)} processed; ok={len(successes)} "
                    f"failed={len(failures)}"
                )

    successes.sort(key=lambda x: int(x["bodyId"]))
    failures.sort(key=lambda x: int(x["bodyId"]))
    manifest = {
        "schema": "maleflyconnectome-swc-download-manifest-v1",
        "dataset": DATASET,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "annotations_url": ANNOTATIONS_URL,
        "annotations_sha256": sha256_file(annotations),
        "skeleton_base_url": SWC_BASE,
        "selection": selection_meta,
        "requested_body_ids": len(body_ids),
        "downloaded": len(successes),
        "failed": len(failures),
        "files": successes,
        "failures": failures,
    }
    manifest_path = output / "download_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Manifest: {manifest_path}")
    if failures:
        raise SystemExit(f"{len(failures)} skeleton downloads failed; inspect the manifest")

if __name__ == "__main__":
    main()
