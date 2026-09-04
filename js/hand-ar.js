const MP_VERSION = '0.10.22';
const MP_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandARController {
  constructor({ video, camera3d, sceneRoot, onStatus = () => {} }) {
    this.video = video;
    this.camera3d = camera3d;
    this.sceneRoot = sceneRoot;
    this.onStatus = onStatus;
    this.handLandmarker = null;
    this.stream = null;
    this.active = false;
    this.backend = null;
    this.mirrored = false;
    this.lastVideoTime = -1;
    this.lastInferenceAt = 0;
    this.lastHandSeen = 0;
    this.lastStatus = '';
    this.detectionErrorReported = false;
  }

  status(text) {
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.onStatus(text);
  }

  async initModel() {
    if (this.handLandmarker) return;
    this.status('Camera active · loading MediaPipe hand detector…');

    const { FilesetResolver, HandLandmarker } = await import(MP_ROOT);
    const vision = await FilesetResolver.forVisionTasks(`${MP_ROOT}/wasm`);
    const options = {
      baseOptions: { modelAssetPath: HAND_MODEL },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    };

    try {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'GPU' }
      });
      this.backend = 'GPU';
    } catch (gpuError) {
      console.warn('MediaPipe GPU delegate failed; retrying on CPU.', gpuError);
      this.status('GPU hand tracking unavailable · retrying on CPU…');
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, options);
      this.backend = 'CPU';
    }
  }

  async openCamera() {
    const preferred = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(preferred);
    } catch (preferredError) {
      console.warn('Rear-camera request failed; retrying with a generic camera.', preferredError);
      this.status('Rear camera unavailable · retrying with available camera…');
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;

    if (this.video.readyState < 1) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Camera metadata timed out.')), 8000);
        this.video.addEventListener('loadedmetadata', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }

    await this.video.play();

    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    this.mirrored = settings.facingMode === 'user';
    this.video.style.transform = this.mirrored ? 'scaleX(-1)' : 'none';
  }

  async start() {
    if (!window.isSecureContext) throw new Error('Camera AR requires a secure HTTPS context.');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API is not available in this browser.');
    if (this.active) return;

    this.status('Requesting camera permission…');
    await this.openCamera();
    this.active = true;
    this.lastVideoTime = -1;
    this.lastInferenceAt = 0;
    this.lastHandSeen = performance.now();
    this.detectionErrorReported = false;

    try {
      await this.initModel();
    } catch (error) {
      this.stop();
      throw new Error(`Hand detector failed to initialize: ${error?.message || error}`);
    }

    this.status(`AR ready · camera active · hand tracking ${this.backend} · show an open palm.`);
  }

  stop() {
    this.active = false;
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.video.style.transform = '';
    this.lastVideoTime = -1;
    this.lastInferenceAt = 0;
    this.lastStatus = '';
  }

  landmarkToViewport(lm) {
    const vw = this.video.videoWidth || innerWidth;
    const vh = this.video.videoHeight || innerHeight;
    const sw = innerWidth;
    const sh = innerHeight;

    // Match CSS object-fit: cover so hand landmarks and the visible video line up.
    const coverScale = Math.max(sw / vw, sh / vh);
    const renderedW = vw * coverScale;
    const renderedH = vh * coverScale;
    const cropX = (renderedW - sw) / 2;
    const cropY = (renderedH - sh) / 2;

    let x = (lm.x * renderedW - cropX) / sw;
    const y = (lm.y * renderedH - cropY) / sh;
    if (this.mirrored) x = 1 - x;
    return { x, y };
  }

  normalizedToWorld(lm, distance = 3.2) {
    const p = this.landmarkToViewport(lm);
    const Vector3 = this.camera3d.position.constructor;
    const v = new Vector3(p.x * 2 - 1, 1 - p.y * 2, 0.25);
    v.unproject(this.camera3d);
    const dir = v.sub(this.camera3d.position).normalize();
    return this.camera3d.position.clone().add(dir.multiplyScalar(distance));
  }

  update(now) {
    if (!this.active || !this.handLandmarker || this.video.readyState < 2) return false;
    if (now - this.lastInferenceAt < 33) return false; // cap hand inference near 30 Hz
    if (this.video.currentTime === this.lastVideoTime) return false;

    this.lastInferenceAt = now;
    this.lastVideoTime = this.video.currentTime;

    let result;
    try {
      result = this.handLandmarker.detectForVideo(this.video, Math.round(now));
      this.detectionErrorReported = false;
    } catch (error) {
      if (!this.detectionErrorReported) {
        console.error('Hand tracking inference failed.', error);
        this.status(`Hand tracking error: ${error?.message || error}`);
        this.detectionErrorReported = true;
      }
      return false;
    }

    const hand = result.landmarks?.[0];
    if (!hand) {
      if (performance.now() - this.lastHandSeen > 900) {
        this.status(`Camera active · ${this.backend} tracking ready · move an open palm near the center.`);
      }
      return false;
    }

    this.lastHandSeen = performance.now();
    const palmIds = [0, 5, 9, 13, 17];
    const palm = palmIds.reduce(
      (acc, i) => ({ x: acc.x + hand[i].x / palmIds.length, y: acc.y + hand[i].y / palmIds.length }),
      { x: 0, y: 0 }
    );

    const pCenter = this.normalizedToWorld(palm);
    const p5 = this.normalizedToWorld(hand[5]);
    const p17 = this.normalizedToWorld(hand[17]);
    const palmWidth = Math.max(0.08, p5.distanceTo(p17));

    const s5 = this.landmarkToViewport(hand[5]);
    const s17 = this.landmarkToViewport(hand[17]);
    const angle = -Math.atan2(s17.y - s5.y, s17.x - s5.x);

    this.sceneRoot.position.lerp(pCenter, 0.32);
    const targetScale = Math.min(0.72, Math.max(0.12, palmWidth * 0.55));
    const nextScale = this.sceneRoot.scale.x + (targetScale - this.sceneRoot.scale.x) * 0.30;
    this.sceneRoot.scale.setScalar(nextScale);
    this.sceneRoot.rotation.z += (angle - this.sceneRoot.rotation.z) * 0.24;
    this.sceneRoot.rotation.x += (-0.28 - this.sceneRoot.rotation.x) * 0.10;

    this.status(`Hand detected · connectome anchored to palm · ${this.backend} tracking.`);
    return true;
  }
}
