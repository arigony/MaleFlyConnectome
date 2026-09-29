#!/usr/bin/env python3
"""Build topology-preserving multiscale render bundles from MaleCNS SWC skeletons."""

from __future__ import annotations
import argparse, hashlib, json, math, os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

DATASET = "male-cns:v1.0"
SOURCE_UNIT_NM = 8
DEFAULT_LEVELS = "overview:256,regional:96,detailed:24"

@dataclass(frozen=True)
class Node:
    node_id: int
    swc_type: int
    x: float
    y: float
    z: float
    radius: float
    parent_id: int

    @property
    def xyz(self):
        return (self.x, self.y, self.z)

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def parse_swc(path: Path) -> dict[int, Node]:
    nodes = {}
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 7:
            raise ValueError(f"{path}:{lineno}: expected >=7 SWC columns")
        node = Node(
            int(parts[0]), int(float(parts[1])), float(parts[2]), float(parts[3]),
            float(parts[4]), float(parts[5]), int(parts[6])
        )
        if node.node_id in nodes:
            raise ValueError(f"{path}:{lineno}: duplicate node id {node.node_id}")
        nodes[node.node_id] = node
    if not nodes:
        raise ValueError(f"{path}: no SWC nodes found")
    return nodes

def build_children(nodes):
    children = {nid: [] for nid in nodes}
    for node in nodes.values():
        if node.parent_id < 0:
            continue
        if node.parent_id not in nodes:
            raise ValueError(f"Node {node.node_id} references missing parent {node.parent_id}")
        children[node.parent_id].append(node.node_id)
    return children

def anchor_ids(nodes, children):
    anchors = set()
    for nid, node in nodes.items():
        if node.parent_id < 0 or len(children[nid]) != 1:
            anchors.add(nid)
            continue
        parent = nodes[node.parent_id]
        if node.swc_type != parent.swc_type:
            anchors.add(nid)
            continue
        only_child = nodes[children[nid][0]]
        if only_child.swc_type != node.swc_type:
            anchors.add(nid)
    return anchors

def decompose_chains(nodes, children, anchors):
    chains, visited_edges = [], set()
    for start in sorted(anchors):
        for child in children[start]:
            if (start, child) in visited_edges:
                continue
            chain = [start, child]
            visited_edges.add((start, child))
            current = child
            while current not in anchors and len(children[current]) == 1:
                nxt = children[current][0]
                visited_edges.add((current, nxt))
                chain.append(nxt)
                current = nxt
            chains.append(chain)
    expected_edges = {
        (n.parent_id, n.node_id) for n in nodes.values() if n.parent_id >= 0
    }
    if visited_edges != expected_edges:
        raise ValueError(
            f"Chain decomposition mismatch: missing={len(expected_edges-visited_edges)}, "
            f"extra={len(visited_edges-expected_edges)}"
        )
    return chains

def point_segment_distance(p, a, b):
    ab = tuple(b[i] - a[i] for i in range(3))
    ap = tuple(p[i] - a[i] for i in range(3))
    denom = sum(v * v for v in ab)
    if denom == 0:
        return math.dist(p, a)
    t = max(0.0, min(1.0, sum(ap[i] * ab[i] for i in range(3)) / denom))
    q = tuple(a[i] + t * ab[i] for i in range(3))
    return math.dist(p, q)

def rdp_indices(points, epsilon):
    if len(points) <= 2 or epsilon <= 0:
        return list(range(len(points)))
    stack = [(0, len(points) - 1)]
    keep = {0, len(points) - 1}
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        a, b = points[first], points[last]
        max_dist, max_idx = -1.0, -1
        for i in range(first + 1, last):
            d = point_segment_distance(points[i], a, b)
            if d > max_dist:
                max_dist, max_idx = d, i
        if max_dist > epsilon:
            keep.add(max_idx)
            stack.append((first, max_idx))
            stack.append((max_idx, last))
    return sorted(keep)

def flatten_segments(nodes, chains, tolerance):
    flat, rendered_nodes = [], 0
    for chain in chains:
        pts = [nodes[nid].xyz for nid in chain]
        keep = rdp_indices(pts, tolerance)
        simp = [pts[i] for i in keep]
        rendered_nodes += len(simp)
        for a, b in zip(simp, simp[1:]):
            flat.extend((*a, *b))
    return flat, rendered_nodes

def parse_levels(spec):
    out, seen = [], set()
    for token in spec.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            name, raw = token.split(":", 1)
            tolerance = float(raw)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(
                f"Invalid LOD token {token!r}; expected name:tolerance"
            ) from exc
        name = name.strip()
        if not name or name in seen or tolerance < 0:
            raise argparse.ArgumentTypeError(f"Invalid LOD level {token!r}")
        seen.add(name)
        out.append((name, tolerance))
    if not out:
        raise argparse.ArgumentTypeError("At least one LOD level is required")
    return out

def update_bounds(bounds, nodes: Iterable[Node]):
    for n in nodes:
        bounds[0] = min(bounds[0], n.x)
        bounds[1] = min(bounds[1], n.y)
        bounds[2] = min(bounds[2], n.z)
        bounds[3] = max(bounds[3], n.x)
        bounds[4] = max(bounds[4], n.y)
        bounds[5] = max(bounds[5], n.z)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/skeletons")
    parser.add_argument("--output", default="data/lod")
    parser.add_argument("--levels", default=DEFAULT_LEVELS)
    parser.add_argument("--round", type=int, default=2, dest="round_digits")
    args = parser.parse_args()

    input_dir, output_dir = Path(args.input), Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    levels = parse_levels(args.levels)
    paths = sorted(input_dir.glob("*.swc"), key=lambda p: p.stem)
    if not paths:
        raise SystemExit(f"No SWC files found in {input_dir}")

    bundles = {
        name: {
            "schema": "maleflyconnectome-lod-v1",
            "dataset": DATASET,
            "coordinate_unit_nm": SOURCE_UNIT_NM,
            "level": name,
            "rdp_tolerance_units": tol,
            "rdp_tolerance_nm": tol * SOURCE_UNIT_NM,
            "neurons": [],
        }
        for name, tol in levels
    }
    global_bounds = [math.inf, math.inf, math.inf, -math.inf, -math.inf, -math.inf]
    metrics = []

    for path in paths:
        nodes = parse_swc(path)
        children = build_children(nodes)
        anchors = anchor_ids(nodes, children)
        chains = decompose_chains(nodes, children, anchors)
        update_bounds(global_bounds, nodes.values())
        original_segments = sum(1 for n in nodes.values() if n.parent_id >= 0)
        source_hash = sha256_file(path)
        row = {
            "bodyId": path.stem,
            "source_file": path.as_posix(),
            "source_sha256": source_hash,
            "original_nodes": len(nodes),
            "original_segments": original_segments,
            "anchors": len(anchors),
            "chains": len(chains),
            "levels": {},
        }

        for name, tol in levels:
            flat, rendered_nodes = flatten_segments(nodes, chains, tol)
            flat = [round(v, args.round_digits) for v in flat]
            rendered_segments = len(flat) // 6
            bundles[name]["neurons"].append({
                "bodyId": path.stem,
                "source_sha256": source_hash,
                "segments": flat,
                "original_nodes": len(nodes),
                "rendered_segments": rendered_segments,
            })
            reduction = (
                0.0 if original_segments == 0
                else 100 * (1 - rendered_segments / original_segments)
            )
            row["levels"][name] = {
                "tolerance_units": tol,
                "tolerance_nm": tol * SOURCE_UNIT_NM,
                "rendered_chain_points": rendered_nodes,
                "rendered_segments": rendered_segments,
                "segment_reduction_pct": round(reduction, 4),
                "rdp_error_bound_units": tol,
                "rdp_error_bound_nm": tol * SOURCE_UNIT_NM,
                "anchors_retained": len(anchors),
                "topology_preserved_by_construction": True,
            }
        metrics.append(row)

    source_date_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    generated = (
        datetime.fromtimestamp(int(source_date_epoch), timezone.utc).isoformat()
        if source_date_epoch
        else datetime.now(timezone.utc).isoformat()
    )
    bounds_obj = {"min": global_bounds[:3], "max": global_bounds[3:]}
    file_manifest = []

    for name, _ in levels:
        bundle = bundles[name]
        bundle["generated_utc"] = generated
        bundle["bounds"] = bounds_obj
        bundle["neuron_count"] = len(bundle["neurons"])
        path = output_dir / f"{name}.json"
        path.write_text(
            json.dumps(bundle, separators=(",", ":"), ensure_ascii=False),
            encoding="utf-8",
        )
        file_manifest.append({
            "level": name,
            "path": path.as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        })

    metrics_path = output_dir / "metrics.json"
    metrics_payload = {
        "schema": "maleflyconnectome-lod-metrics-v1",
        "dataset": DATASET,
        "coordinate_unit_nm": SOURCE_UNIT_NM,
        "generated_utc": generated,
        "neuron_count": len(metrics),
        "bounds": bounds_obj,
        "neurons": metrics,
    }
    metrics_path.write_text(
        json.dumps(metrics_payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    manifest = {
        "schema": "maleflyconnectome-lod-manifest-v1",
        "dataset": DATASET,
        "coordinate_unit_nm": SOURCE_UNIT_NM,
        "generated_utc": generated,
        "source_directory": input_dir.as_posix(),
        "neuron_count": len(paths),
        "bounds": bounds_obj,
        "levels": [
            {"name": n, "tolerance_units": t, "tolerance_nm": t * SOURCE_UNIT_NM}
            for n, t in levels
        ],
        "files": file_manifest + [{
            "path": metrics_path.as_posix(),
            "bytes": metrics_path.stat().st_size,
            "sha256": sha256_file(metrics_path),
        }],
        "scientific_guarantees": {
            "branch_graph_preserved_by_construction": True,
            "roots_branchpoints_leaves_retained": True,
            "swc_type_transition_anchors_retained": True,
            "connectivity_modified": False,
            "ai_generated_biology": False,
        },
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Built {len(levels)} LOD levels for {len(paths)} skeletons")

if __name__ == "__main__":
    main()
