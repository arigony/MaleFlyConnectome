# Validation plan — publication-grade target

The project should be evaluated as a scientific data interface, not merely as an attractive visualization.

## A. Identity and morphology fidelity

1. **Identity fidelity** — 100% of displayed neuron body IDs must match the source export.
2. **Topology fidelity** — every displayed SWC child→parent relation must exist in the source skeleton. Target: 100%.
3. **Coordinate fidelity** — all simultaneously displayed neurons must use the same documented affine display transform. No independent per-neuron reshaping.
4. **Export integrity** — `data/manifest.json` records SHA-256 hashes for exported scientific files.
5. **No AI-derived biology** — generative AI may assist code, documentation and refactoring but must not generate neuron IDs, edges, weights or biological annotations.

## B. Connectivity fidelity

For every displayed pre→post edge:

- compare `bodyId_pre`;
- compare `bodyId_post`;
- compare total `weight`;
- compare cell type/instance labels where present;
- retain the exact dataset version and query filter.

Target for displayed edges: **100% correspondence with the fixed exported neuPrint result**.

## C. Multiscale / LOD validation

When LOD is introduced, record at each level:

- original node count;
- rendered node/segment count;
- retained branch points;
- geometric error, for example Hausdorff or point-to-polyline distance;
- retained connectivity metadata;
- transfer size and decode/render time.

Do not claim “no loss of resolution”. Claim preservation of specified scientific information and quantify geometric simplification.

## D. Mobile performance

Benchmark at minimum:

- one mid-range Android phone;
- one high-end Android phone;
- one recent iPhone;
- desktop reference.

Record cold load time, transferred bytes, time to first interactive frame, median FPS, 5th-percentile FPS, camera/hand-tracking latency, and peak memory where measurable.

Initial MVP targets for a circuit-scale demonstration:

- median ≥ 30 FPS;
- first interactive frame ≤ 5 s on normal Wi-Fi;
- visible hand-region acquisition ≤ 2 s under normal lighting;
- zero scientific-data mismatches in automated validation.

## E. AR wording

The v0.2 implementation is a **markerless hand-anchored camera overlay** based on hand landmarks and apparent palm width. It is not yet a calibrated metric 6-DoF WebXR spatial anchor. A publication must use wording consistent with the actual implementation or upgrade the tracking method.

## F. Educational/task study — second phase

Only after technical stability, compare conventional 2D, interactive 3D and hand-anchored AR for spatial/connectomic tasks. Predefine a primary outcome before data collection. Usability or engagement alone must not be interpreted as learning gain.
