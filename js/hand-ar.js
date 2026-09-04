export class HandARController {
  constructor({ video, camera3d, sceneRoot, onStatus = () => {} }) {
    this.video = video;
    this.camera3d = camera3d;
    this.sceneRoot = sceneRoot;
    this.onStatus = onStatus;
    this.handLandmarker = null;
    this.stream = null;
    this.active = false;
    this.lastVideoTime = -1;
    this.lastHandSeen = 0;
  }

  async initModel() {
    if (this.handLandmarker) return;
    this.onStatus('Loading hand detector…');
    const { FilesetResolver, HandLandmarker } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs');
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
    this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minTrackingConfidence: 0.55
    });
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API is not available in this browser.');
    await this.initModel();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.active = true;
    this.lastVideoTime = -1;
    this.onStatus('Camera AR active · looking for an open hand…');
  }

  stop() {
    this.active = false;
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastVideoTime = -1;
  }

  normalizedToWorld(lm, distance = 3.2) {
    // The camera feed is mirrored in CSS, hence the x flip here.
    const v = new this.camera3d.position.constructor((1 - lm.x) * 2 - 1, 1 - lm.y * 2, 0.25);
    v.unproject(this.camera3d);
    const dir = v.sub(this.camera3d.position).normalize();
    return this.camera3d.position.clone().add(dir.multiplyScalar(distance));
  }

  update(now) {
    if (!this.active || !this.handLandmarker || this.video.readyState < 2 || this.video.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = this.video.currentTime;
    const result = this.handLandmarker.detectForVideo(this.video, now);
    const hand = result.landmarks?.[0];
    if (!hand) {
      if (performance.now() - this.lastHandSeen > 700) this.onStatus('Camera AR active · show an open hand near the center.');
      return false;
    }

    this.lastHandSeen = performance.now();
    const palmIds = [0, 5, 9, 13, 17];
    const palm = palmIds.reduce((acc, i) => ({ x: acc.x + hand[i].x / palmIds.length, y: acc.y + hand[i].y / palmIds.length }), { x: 0, y: 0 });
    const pCenter = this.normalizedToWorld(palm);
    const p5 = this.normalizedToWorld(hand[5]);
    const p17 = this.normalizedToWorld(hand[17]);
    const palmWidth = Math.max(0.05, p5.distanceTo(p17));
    const angle = Math.atan2(hand[17].y - hand[5].y, hand[17].x - hand[5].x);

    this.sceneRoot.position.lerp(pCenter, 0.28);
    const targetScale = palmWidth * 0.48;
    const currentScale = this.sceneRoot.scale.x;
    const nextScale = currentScale + (targetScale - currentScale) * 0.28;
    this.sceneRoot.scale.setScalar(nextScale);
    this.sceneRoot.rotation.z += (angle - this.sceneRoot.rotation.z) * 0.22;
    this.sceneRoot.rotation.x += (-0.35 - this.sceneRoot.rotation.x) * 0.08;
    this.onStatus('Hand detected · connectome follows the palm region.');
    return true;
  }
}
