# Multiscale LOD pipeline — v0.4 research milestone

## Purpose

The publication target is not merely to place a connectome illustration in AR. The technical question is whether a very large, source-traceable connectomic dataset can be transformed into a browser/mobile representation while preserving explicitly defined scientific information.

The v0.4 preprocessing pipeline therefore separates **scientific source data** from **render geometry**.

```text
MaleCNS v1.0
  ├─ curated annotations
  ├─ SWC centerline skeletons (8 nm coordinate units)
  └─ neuron-to-neuron connectivity
          ↓
reproducible preprocessing
          ↓
topology-preserving LOD bundles + metrics + hashes
          ↓
browser 3D
          ↓
hand-anchored camera AR
```

## Why LOD is necessary

The MaleCNS contains roughly 166,700 neurons and 11,710 annotated neuron types. Loading every full SWC centerline into a mobile browser at once is not a realistic rendering strategy. The scientific dataset remains unchanged; only the geometry sent to the renderer is simplified.

The default prototype levels are:

| level | RDP tolerance | physical equivalent |
|---|---:|---:|
| `overview` | 256 source units | 2048 nm |
| `regional` | 96 source units | 768 nm |
| `detailed` | 24 source units | 192 nm |

These are **rendering tolerances**, not microscopy resolution claims.

## Topology-preserving simplification

`scripts/build_lod.py` parses each SWC tree and identifies anchors that must never be deleted:

- roots;
- leaves;
- branch points;
- points at SWC-type transitions.

The tree is decomposed into degree-2 chains between anchors. Three-dimensional Ramer-Douglas-Peucker simplification is applied only inside those chains. The branch graph is therefore preserved by construction.

For each neuron and level the pipeline records:

- original node and segment counts;
- anchor and chain counts;
- rendered segment count;
- segment reduction percentage;
- configured geometric error bound;
- SHA-256 of the source SWC.

The connectivity graph is not touched by LOD generation.

## Reproducible dataset acquisition

`scripts/fetch_malecns_skeletons.py` downloads the official MaleCNS v1.0 annotation table and SWCs from the public Janelia/FlyEM Google Storage locations.

Three useful modes are supported:

```bash
# Small smoke test
python scripts/fetch_malecns_skeletons.py --one-per-type --limit 100

# Type-level whole-CNS development set
python scripts/fetch_malecns_skeletons.py --one-per-type

# Explicit body IDs
python scripts/fetch_malecns_skeletons.py --body-ids 12781,556329
```

For `--one-per-type`, the script chooses the smallest numeric body ID in each annotated type **deterministically**. This is an engineering sampling rule, not a claim that the selected neuron is a canonical biological representative.

The full-neuron build can later be generated from all annotated body IDs in a high-bandwidth environment.

## Build and validate

For the skeletons already cached in this repository:

```bash
python scripts/build_lod.py --input data/skeletons --output data/lod
python scripts/validate_lod.py --dir data/lod
```

The output is:

```text
data/lod/
  overview.json
  regional.json
  detailed.json
  metrics.json
  manifest.json
```

`manifest.json` stores file hashes, coordinate units, tolerances, bounds and scientific guarantees. `metrics.json` is intended to feed the manuscript's fidelity/performance figures.

## Publication measurements

Before submission, the following must be measured rather than assumed:

1. geometric reduction at each LOD;
2. branch-point retention;
3. exact identity and connectivity preservation;
4. transferred bytes and decode time;
5. FPS and 5th-percentile FPS on representative phones;
6. time to first interactive frame;
7. hand-tracking acquisition/latency;
8. task performance in 2D vs 3D vs AR, if an educational experiment is included.

A strong claim is **preservation of defined connectomic information under quantified geometric simplification**. The project must not claim voxel-level or “lossless 8 nm” mobile rendering.
