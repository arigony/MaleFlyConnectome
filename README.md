# Male Fly Connectome AR

**Putting a connectome in your hand — without letting generative AI invent the biology.**

Male Fly Connectome AR is an open research prototype for transforming authoritative **MaleCNS v1.0** data into an interactive browser-based 3D representation and a markerless, hand-anchored camera AR view.

The scientific design principle is strict: **AI may assist software development, but neuron identities, morphology, connectivity and synaptic weights must come from the source connectome.**

## Current research status

Version **0.2.0** is an early technical prototype, not yet a validated scientific instrument. It currently provides:

- loading of real MaleCNS SWC centerline skeletons by `bodyId`;
- official DNge104 examples (`12781`, `556329`) as the default demonstrator;
- one global affine display normalization across all loaded neurons, rather than per-neuron warping;
- interactive Three.js 3D orbit, zoom, fit and selection;
- optional local neuPrint connectivity export and partner browsing;
- click-to-load upstream/downstream partner skeletons;
- markerless hand-region anchoring using MediaPipe hand landmarks;
- live FPS display for early mobile benchmarking;
- data provenance, validation and licensing documentation.

## Authoritative data source

MaleCNS v1.0 is hosted by the FlyEM/Janelia collaboration and can be explored via neuPrint.

- Project: https://male-cns.janelia.org/
- Download/data documentation: https://male-cns.janelia.org/download/
- neuPrint dataset: `male-cns:v1.0`
- SWC skeletons: Male CNS EM coordinate space, coordinates in **8 nm units**
- Dataset license: **CC BY**

The frontend first looks for reproducible local exports under `data/`. If they are absent, skeletons may be fetched directly from the public MaleCNS Google Storage location.

## Run locally

```bash
python -m http.server 8000
```

Open `http://localhost:8000` for desktop 3D. Camera mode on a phone requires **HTTPS**, so GitHub Pages is the intended public test deployment.

## Export connectivity without exposing credentials

Create a neuPrint account and obtain an API token. Install:

```bash
pip install -r requirements.txt
```

PowerShell:

```powershell
$env:NEUPRINT_APPLICATION_CREDENTIALS="YOUR_TOKEN"
python scripts/export_subset.py --type DNge104 --min-weight 1 --max-partners 0 --partner-skeletons 24
python scripts/validate_export.py
```

bash:

```bash
export NEUPRINT_APPLICATION_CREDENTIALS="YOUR_TOKEN"
python scripts/export_subset.py --type DNge104 --min-weight 1 --max-partners 0 --partner-skeletons 24
python scripts/validate_export.py
```

`--max-partners 0` means **keep all seed-adjacent edges returned by the query**. The browser can then filter the exported result interactively. `--partner-skeletons` controls how many top partner morphologies are also cached locally.

The export creates:

```text
data/connectivity.json
data/manifest.json
data/skeletons/<bodyId>.json
```

The manifest records file sizes and SHA-256 hashes. The neuPrint token is never written to the repository or frontend.

## Scientific claims we are willing to make

For the current architecture, the defensible target is **preservation of source identity, connectivity metadata and SWC topology under a documented display transform**.

We do **not** claim:

- voxel-perfect rendering of the 8 nm EM volume on a phone;
- “no loss of resolution”;
- that AI infers biological connectivity;
- that the current hand overlay is a calibrated metric 6-DoF WebXR anchor;
- educational benefit before a controlled study is performed.

See [docs/VALIDATION.md](docs/VALIDATION.md) and [docs/METHODS.md](docs/METHODS.md).

## Intended manuscript direction

The working methodological contribution is:

> **A reproducible, browser-based multiscale pipeline for scientifically traceable exploration of connectomic data in 3D and augmented reality.**

A possible target is *iScience*, but journal suitability will depend on quantitative validation, mobile performance, a biologically meaningful demonstration such as sexually dimorphic circuitry, reproducibility, and ideally a controlled educational or task-performance study.

See [docs/EDITORIAL_POSITIONING.md](docs/EDITORIAL_POSITIONING.md).

## Repository structure

```text
.
├── index.html
├── css/style.css
├── js/
│   ├── app.js
│   ├── config.js
│   ├── connectome.js
│   ├── hand-ar.js
│   └── swc-loader.js
├── data/
│   └── skeletons/
├── scripts/
│   ├── export_subset.py
│   └── validate_export.py
├── docs/
├── DATA_LICENSE.md
├── CITATION.cff
└── LICENSE
```

## Licensing

Repository software is MIT licensed. MaleCNS-derived scientific data are separate from the software license and remain subject to the source dataset's CC BY terms. See [DATA_LICENSE.md](DATA_LICENSE.md).
