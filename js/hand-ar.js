const MP_VERSION = '0.10.22-rc.20250304';
const MP_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MP_MODULE = `${MP_ROOT}/vision_bundle.mjs`;
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
    this.vision = null;
    this.HandLandmarker = null;
    this.switchingBackend = false;
    this.gpuFallbackAttempted = false;
    this.isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia?.('(pointer: coarse)').matches;
    this.inferenceInterval = this.isMobile ? 60 : 33;
  }

  status(text) {
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.onStatus(text);
  }

  handOptions(backend = 'CPU') {
    const baseOptions = { modelAssetPath: HAND_MODEL };
    if (backend === 'GPU') baseOptions.delegate = 'GPU';
    return {
      baseOptions,
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.35,
      minTrackingConfidence: 0.35
    };
  }

  async createDetector(backend) {
    return this.HandLandmarker.createFromOptions(this.vision, this.handOptions(backend));
  }

  async initModel() {
    if (this.handLandmarker) return;
    this.status(`Camera active · loading MediaPipe ${MP_VERSION} hand detector…`);

    const { FilesetResolver, HandLandmarker } = await import(MP_MODULE);
    this.HandLandmarker = HandLandmarker;
    this.vision = await FilesetResolver.forVisionTasks(`${MP_ROOT}/wasm`);

    // Mobile Chromium/WebView devices can initialize the MediaPipe GPU delegate
    // successfully yet return no hand landmarks. CPU-first is slower but much
    // more reliable on Android/iOS, and the lower camera resolution keeps it usable.
    if (this.isMobile) {
      this.status('Mobile browser detected · starting reliable CPU hand tracking…');
      this.handLandmarker = await this.createDetector('CPU');
      this.backend = 'CPU';
      return;
    }

    try {
      this.handLandmarker = await this.createDetector('GPU');
      this.backend = 'GPU';
    } catch (gpuError) {
      console.warn('MediaPipe GPU delegate failed; retrying on CPU.', gpuError);
      this.status('GPU hand tracking unavailable · retrying on CPU…');
      this.handLandmarker = await this.createDetector('CPU');
      this.backend = 'CPU';
    }
  }

  async switchToCPU(reason = 'GPU produced no hand landmarks') {
    if (this.switchingBackend || this.backend === 'CPU' || !this.HandLandmarker || !this.vision) return;
    this.switchingBackend = true;
    this.gpuFallbackAttempted = true;
    this.status(`${reason} · switching to CPU tracking…`);
    try {
      this.handLandmarker?.close?.();
      this.handLandmarker = await this.createDetector('CPU');
      this.backend = 'CPU';
      this.lastHandSeen = performance.now();
      this.lastVideoTime = -1;
      this.status('CPU hand tracking ready · show an open palm near the center.');
    } catch (error) {
      console.error('CPU hand tracking fallback failed.', error);
      this.status(`CPU tracking fallback failed: ${error?.message || error}`);
    } finally {
      this.switchingBackend = false;
    }
  }

  async openCamera() {
    const preferred = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: false
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(preferred);
    } catch (preferredError) {
      console.warn('Rear-camera request failed; retrying with a generic camera.', preferredError);
      this.status('Rear camera unavailable · retrying with available camera…');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
        audio: false
      });
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
    this.gpuFallbackAttempted = false;

    try {
      await this.initModel();
    } catch (error) {
      this.stop();
      throw new Error(`Hand detector failed to initialize: ${error?.message || error}`);
    }

    this.status(`AR ready · camera active · hand tracking ${this.backend} · show an open palm to anchor.`);
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
    if (!this.active || !this.handLandmarker || this.video.readyState < 2 || this.switchingBackend) return false;
    if (now - this.lastInferenceAt < this.inferenceInterval) return false;
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
      if (this.backend === 'GPU' && !this.gpuFallbackAttempted) void this.switchToCPU('GPU inference failed');
      return false;
    }

    const hand = result.landmarks?.[0];
    if (!hand) {
      const missingFor = performance.now() - this.lastHandSeen;
      if (this.backend === 'GPU' && !this.gpuFallbackAttempted && missingFor > 1800) {
        void this.switchToCPU('No hand detected on GPU');
        return false;
      }
      if (missingFor > 900) {
        this.status(`Camera active · ${this.backend} tracking ready · show an open palm near the center.`);
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

    const screen = hand.map((lm) => this.landmarkToViewport(lm));
    const s0 = screen[0];
    const s5 = screen[5];
    const s9 = screen[9];
    const s17 = screen[17];
    const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const palmWidthScreen = Math.max(0.01, d2(s5, s17));
    const palmLengthScreen = Math.max(0.01, d2(s0, s9));
    const apparentPalmSize = Math.sqrt(palmWidthScreen * palmLengthScreen);
    const angle = -Math.atan2(s17.y - s5.y, s17.x - s5.x);

    const fingerPairs = [[8, 5], [12, 9], [16, 13], [20, 17]];
    const fingerExtension = fingerPairs.reduce(
      (sum, [tip, mcp]) => sum + d2(screen[tip], screen[mcp]) / palmWidthScreen,
      0
    ) / fingerPairs.length;
    const closeAmount = clamp((1.35 - fingerExtension) / 0.85, 0, 1);
    const gestureZoom = 1 + closeAmount * 1.8;

    this.sceneRoot.position.lerp(pCenter, 0.42);

    const distanceScale = clamp(apparentPalmSize * 4.8, 0.55, 2.4);
    const targetScale = clamp(distanceScale * gestureZoom, 0.55, 5.2);
    const nextScale = this.sceneRoot.scale.x + (targetScale - this.sceneRoot.scale.x) * 0.34;
    this.sceneRoot.scale.setScalar(nextScale);

    this.sceneRoot.rotation.z += (angle - this.sceneRoot.rotation.z) * 0.28;
    this.sceneRoot.rotation.x += (-0.28 - this.sceneRoot.rotation.x) * 0.10;

    const gestureState = closeAmount > 0.35 ? 'fist zoom active' : 'close hand to zoom';
    this.status(`Hand detected · ${gestureState} · ${this.backend} tracking.`);
    return true;
  }
}
