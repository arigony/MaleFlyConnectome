#!/usr/bin/env python3
"""Validate generated MaleFlyConnectome LOD files and publication metrics."""

from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="data/lod")
    args = ap.parse_args()
    root = Path(args.dir)
    manifest = json.loads((root / "manifest.json").read_text())
    metrics = json.loads((root / "metrics.json").read_text())

    assert manifest["dataset"] == "male-cns:v1.0"
    assert manifest["coordinate_unit_nm"] == 8
    assert metrics["neuron_count"] == manifest["neuron_count"]

    for item in manifest["files"]:
        path = Path(item["path"])
        if not path.exists():
            path = root / path.name
        assert path.exists(), f"Missing {path}"
        assert path.stat().st_size == item["bytes"], f"Size mismatch: {path}"
        assert sha256_file(path) == item["sha256"], f"SHA-256 mismatch: {path}"

    for neuron in metrics["neurons"]:
        original = neuron["original_segments"]
        assert neuron["anchors"] >= 1
        for name, level in neuron["levels"].items():
            rendered = level["rendered_segments"]
            assert rendered <= original, (
                f"{neuron['bodyId']} {name}: segment count increased"
            )
            assert level["anchors_retained"] == neuron["anchors"]
            assert level["topology_preserved_by_construction"] is True
            if level["tolerance_units"] == 0:
                assert rendered == original, (
                    f"{neuron['bodyId']} zero-tolerance LOD changed edge count "
                    f"({rendered} != {original})"
                )

    guarantees = manifest["scientific_guarantees"]
    assert guarantees["branch_graph_preserved_by_construction"] is True
    assert guarantees["connectivity_modified"] is False
    assert guarantees["ai_generated_biology"] is False

    print(
        f"LOD validation passed: {manifest['neuron_count']} neurons, "
        f"{len(manifest['levels'])} levels, hashes verified."
    )

if __name__ == "__main__":
    main()
