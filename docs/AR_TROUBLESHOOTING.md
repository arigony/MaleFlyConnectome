# AR troubleshooting and mobile behavior

The markerless hand-anchored mode is a camera-AR research prototype, not a calibrated metric WebXR anchor.

## v0.2.2 robustness changes

- requests the camera before loading the hand-tracking model;
- prefers the rear camera but falls back to any available camera;
- initializes MediaPipe Hand Landmarker with GPU first and falls back to CPU;
- uses the same MediaPipe package root for JavaScript and WASM assets;
- accounts for CSS `object-fit: cover` crop when mapping normalized hand landmarks to the Three.js viewport;
- mirrors only a user-facing camera, not the rear camera;
- limits landmark inference to approximately 30 Hz;
- reports camera/model/tracking state in the runtime status pill.

## Expected states

After pressing **Place on hand**, the status should progress through messages similar to:

1. `Requesting camera permission…`
2. `Camera active · loading MediaPipe hand detector…`
3. `AR ready · camera active · hand tracking GPU/CPU · show an open palm.`
4. `Hand detected · connectome anchored to palm · GPU/CPU tracking.`

If the process stops at one state, that state identifies the failing subsystem.

## Browser notes

The page must run under HTTPS and camera permission must be granted. Device/browser combinations differ in camera constraints and WebAssembly/GPU support, so the implementation deliberately includes camera and CPU fallbacks.
