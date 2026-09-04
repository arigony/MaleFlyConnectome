#!/usr/bin/env python3
"""Validate local MaleCNS export structure and manifest hashes without network access."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fail(message: str) -> None:
    raise SystemExit(f"VALIDATION FAILED: {message}")


def validate_skeleton(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    nodes = data.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        fail(f"{path}: missing nodes")
    ids = {int(n["id"]) for n in nodes}
    for n in nodes:
        for key in ("id", "x", "y", "z", "parent"):
            if key not in n:
                fail(f"{path}: node missing {key}")
        parent = int(n["parent"])
        if parent != -1 and parent not in ids:
            fail(f"{path}: parent {parent} not present for node {n['id']}")


def main() -> None:
    manifest_path = DATA / "manifest.json"
    connectivity_path = DATA / "connectivity.json"
    if not manifest_path.exists() or not connectivity_path.exists():
        fail("run scripts/export_subset.py first")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in manifest.get("files", []):
        path = ROOT / entry["path"]
        if not path.exists():
            fail(f"missing file: {entry['path']}")
        actual = sha256_file(path)
        if actual != entry["sha256"]:
            fail(f"hash mismatch: {entry['path']}")
        if path.parent.name == "skeletons" and path.suffix == ".json":
            validate_skeleton(path)

    con = json.loads(connectivity_path.read_text(encoding="utf-8"))
    seen = set()
    for e in con.get("edges", []):
        key = (str(e["bodyId_pre"]), str(e["bodyId_post"]))
        if key in seen:
            fail(f"duplicate edge {key}")
        seen.add(key)
        if int(e["weight"]) < 1:
            fail(f"non-positive edge weight {key}")

    print(f"VALIDATION OK: {len(seen)} edges; {len(manifest.get('files', []))} hashed data files")


if __name__ == "__main__":
    main()
