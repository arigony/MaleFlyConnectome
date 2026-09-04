export const APP_VERSION = '0.2.1';
export const DATASET = 'male-cns:v1.0';
export const SWC_BASE = 'https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/skeletons-malecns/skeletons-swc/';

export const OFFICIAL_EXAMPLES = Object.freeze({
  '12781': 'DNge104_R',
  '556329': 'DNge104_L'
});

export const DEFAULT_PAIR = Object.freeze(['12781', '556329']);

export const DISPLAY = Object.freeze({
  normalizedExtent: 2.45,
  maxDevicePixelRatio: 2,
  palette: [0x6ee7ff, 0xc084fc, 0xfbbf24, 0x34d399, 0xfb7185, 0x93c5fd],
  selectedColor: 0xffffff,
  dimOpacity: 0.18,
  normalOpacity: 0.92
});
