# Local scientific data

This directory is intentionally small in the source repository.

Use `scripts/export_subset.py` to create reproducible static MaleCNS subsets:

- `connectivity.json` — neuron-to-neuron edges and weights exported from neuPrint;
- `manifest.json` — dataset/query metadata plus SHA-256 hashes;
- `skeletons/<bodyId>.json` — centerline skeletons exported from neuPrint.

Do not commit neuPrint credentials. The frontend never requires a token.

Large full-connectome files, such as the complete connection graph or synapse tables, should not be committed directly to this Git repository. They should be handled as external research data with explicit provenance and versioning.
