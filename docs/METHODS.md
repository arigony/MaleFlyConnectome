# Methods architecture

## Source layer

Authoritative scientific content is obtained from MaleCNS v1.0 (`male-cns:v1.0`). The official download documentation describes SWC centerline skeletons in Male CNS EM coordinate space with coordinates in 8 nm units and provides programmatic neuPrint access for connectivity.

## Export layer

`scripts/export_subset.py` performs authenticated neuPrint queries outside the browser. It exports:

- seed neuron metadata and skeletons;
- incoming and outgoing neuron-to-neuron connection weights;
- optional top-partner skeletons;
- a provenance-rich connectivity JSON;
- a SHA-256 data manifest.

Credentials are supplied only via `NEUPRINT_APPLICATION_CREDENTIALS` and are never serialized into public web files.

## Browser data layer

The browser prefers fixed local exports for reproducibility. If a skeleton is absent locally, the prototype can attempt to load the public MaleCNS SWC object directly by body ID.

Connectivity is never inferred in JavaScript: filters operate only on exported edges.

## 3D representation

SWC parent-child pairs are rendered as line segments using Three.js. For all neurons visible at a given time, one shared transform is calculated from the union bounding box:

1. compute a global 3D center;
2. subtract that center from every source coordinate;
3. multiply all coordinates by one scalar chosen to fit the view.

This preserves relative geometry up to a single translation and uniform scale and avoids independent deformation of neurons.

## Camera AR prototype

The current AR-like mode uses MediaPipe Hand Landmarker on the camera stream. Five landmarks are averaged to approximate the palm region. Apparent palm width controls display scale and the line between index/pinky metacarpal landmarks provides an in-plane orientation estimate.

This is intentionally described as **markerless hand-anchored camera AR/overlay**, not a metrically calibrated world-tracked anchor.

## AI role

Generative AI may assist:

- code generation and refactoring;
- test drafting;
- UI prototyping;
- documentation;
- performance/debugging suggestions.

Generative AI must not be used as the source of:

- neuronal identity;
- morphology coordinates;
- connectivity;
- synaptic weights;
- cell-type annotations presented as MaleCNS facts.

All scientific records must remain source-traceable.
