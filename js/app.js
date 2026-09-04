import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.179.1/examples/jsm/controls/OrbitControls.js';
import { APP_VERSION, DATASET, DEFAULT_PAIR, DISPLAY } from './config.js';
import { fetchSkeleton, countSegments } from './swc-loader.js';
import { fetchConnectivity, labelForPartner, partnersForSeed } from './connectome.js';
import { HandARController } from './hand-ar.js';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), video: $('cameraFeed'), status: $('status'), arHelp: $('arHelp'),
  bodyId: $('bodyId'), loadBody: $('loadBody'), loadPair: $('loadPair'), clearScene: $('clearScene'),
  fitView: $('fitView'), toggleRotate: $('toggleRotate'), toggleAR: $('toggleAR'), exitAR: $('exitAR'),
  loadConnectivity: $('loadConnectivity'), applyConnectivity: $('applyConnectivity'), connectivitySummary: $('connectivitySummary'),
  seedSelect: $('seedSelect'), directionSelect: $('directionSelect'), minWeight: $('minWeight'), minWeightValue: $('minWeightValue'),
  partnerList: $('partnerList'), nNeurons: $('nNeurons'), nNodes: $('nNodes'), nSegments: $('nSegments'), fps: $('fps'),
  dataModeBadge: $('dataModeBadge'), panelToggle: $('panelToggle')
};

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, DISPLAY.maxDevicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x05070b, 1);
els.stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 0, 4.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;

const sceneRoot = new THREE.Group();
const dataRoot = new THREE.Group();
sceneRoot.add(dataRoot);
scene.add(sceneRoot);
scene.add(new THREE.HemisphereLight(0xffffff, 0x243042, 1.2));
const directional = new THREE.DirectionalLight(0xffffff, 1.4);
directional.position.set(2, 3, 4);
scene.add(directional);
const grid = new THREE.GridHelper(4, 12, 0x25425a, 0x142131);
grid.rotation.x = Math.PI / 2;
grid.position.z = -1.3;
scene.add(grid);

const state = {
  loaded: new Map(),
  meshes: new Map(),
  autoRotate: false,
  arMode: false,
  connectivity: null,
  selectedBodyId: null,
  fpsTimes: []
};

const handAR = new HandARController({
  video: els.video,
  camera3d: camera,
  sceneRoot,
  onStatus: setStatus
});

function setStatus(text) { els.status.textContent = text; }
function setDataBadge(text) { els.dataModeBadge.textContent = text; }

function disposeObject(object) {
  object.traverse((o) => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
    else o.material?.dispose?.();
  });
}

function clearGeometry() {
  [...dataRoot.children].forEach(disposeObject);
  dataRoot.clear();
  state.meshes.clear();
}

function resetSceneData() {
  clearGeometry();
  state.loaded.clear();
  state.selectedBodyId = null;
  updateSeedSelector();
  updateStats();
  fitView();
  setStatus('Scene cleared.');
}

function computeGlobalTransform(datasets) {
  const bbox = new THREE.Box3();
  for (const d of datasets) {
    for (const n of d.nodes) bbox.expandByPoint(new THREE.Vector3(n.x, n.y, n.z));
  }
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  return { center, scale: DISPLAY.normalizedExtent / maxDim };
}

function makeSkeletonLines(dataset, transform, index) {
  const byId = new Map(dataset.nodes.map((n) => [n.id, n]));
  const verts = [];
  for (const n of dataset.nodes) {
    const parent = byId.get(n.parent);
    if (!parent) continue;
    verts.push(
      (n.x - transform.center.x) * transform.scale,
      (n.y - transform.center.y) * transform.scale,
      (n.z - transform.center.z) * transform.scale,
      (parent.x - transform.center.x) * transform.scale,
      (parent.y - transform.center.y) * transform.scale,
      (parent.z - transform.center.z) * transform.scale
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const baseColor = DISPLAY.palette[index % DISPLAY.palette.length];
  const material = new THREE.LineBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: DISPLAY.normalOpacity
  });
  material.userData.baseColor = baseColor;
  const lines = new THREE.LineSegments(geometry, material);
  lines.userData = { bodyId: dataset.bodyId, label: dataset.label, source: dataset.source };
  return lines;
}

function rebuildGeometry() {
  clearGeometry();
  const datasets = [...state.loaded.values()];
  if (!datasets.length) {
    updateStats();
    return;
  }
  const transform = computeGlobalTransform(datasets);
  datasets.forEach((dataset, index) => {
    const lines = makeSkeletonLines(dataset, transform, index);
    dataRoot.add(lines);
    state.meshes.set(dataset.bodyId, lines);
  });
  applySelectionVisuals();
  updateStats();
  updateSeedSelector();

  const localCount = datasets.filter((d) => d.source === 'local-export').length;
  const remoteCount = datasets.length - localCount;
  setDataBadge(`data: ${localCount} local · ${remoteCount} remote`);
  setStatus(`${datasets.length} neuron(s) rendered with one global affine display transform; SWC parent-child topology retained.`);
}

function applySelectionVisuals() {
  for (const [bodyId, mesh] of state.meshes.entries()) {
    const selected = !state.selectedBodyId || bodyId === state.selectedBodyId;
    mesh.material.opacity = selected ? DISPLAY.normalOpacity : DISPLAY.dimOpacity;
    mesh.material.color.set(selected && state.selectedBodyId ? DISPLAY.selectedColor : mesh.material.userData.baseColor);
  }
}

function restorePalette() {
  [...state.meshes.entries()].forEach(([, mesh]) => {
    mesh.material.color.set(mesh.material.userData.baseColor);
    mesh.material.opacity = DISPLAY.normalOpacity;
  });
}

async function loadBody(bodyId, { select = false } = {}) {
  bodyId = String(bodyId).trim();
  if (!/^\d+$/.test(bodyId)) throw new Error('Enter a numeric MaleCNS bodyId.');
  if (!state.loaded.has(bodyId)) {
    setStatus(`Loading authoritative skeleton ${bodyId}…`);
    const data = await fetchSkeleton(bodyId);
    state.loaded.set(bodyId, data);
    rebuildGeometry();
  }
  if (select) selectBody(bodyId);
  return state.loaded.get(bodyId);
}

async function loadDefaultPair() {
  await Promise.all(DEFAULT_PAIR.map((id) => loadBody(id)));
  restorePalette();
  state.selectedBodyId = null;
  updateSeedSelector();
  fitView();
}

function selectBody(bodyId) {
  state.selectedBodyId = String(bodyId);
  restorePalette();
  for (const [id, mesh] of state.meshes.entries()) {
    const selected = id === state.selectedBodyId;
    mesh.material.opacity = selected ? 1 : DISPLAY.dimOpacity;
    if (selected) mesh.material.color.set(DISPLAY.selectedColor);
  }
  if ([...els.seedSelect.options].some((o) => o.value === state.selectedBodyId)) els.seedSelect.value = state.selectedBodyId;
}

function updateSeedSelector() {
  const previous = els.seedSelect.value;
  els.seedSelect.replaceChildren();
  for (const dataset of state.loaded.values()) {
    const option = document.createElement('option');
    option.value = dataset.bodyId;
    option.textContent = `${dataset.label} · ${dataset.bodyId}`;
    els.seedSelect.appendChild(option);
  }
  if (previous && [...els.seedSelect.options].some((o) => o.value === previous)) els.seedSelect.value = previous;
  else if (state.selectedBodyId && [...els.seedSelect.options].some((o) => o.value === state.selectedBodyId)) els.seedSelect.value = state.selectedBodyId;
  els.applyConnectivity.disabled = !state.connectivity || !els.seedSelect.options.length;
}

function updateStats() {
  const datasets = [...state.loaded.values()];
  els.nNeurons.textContent = datasets.length.toLocaleString('en-US');
  els.nNodes.textContent = datasets.reduce((sum, d) => sum + d.nodes.length, 0).toLocaleString('en-US');
  els.nSegments.textContent = datasets.reduce((sum, d) => sum + countSegments(d), 0).toLocaleString('en-US');
}

function fitView() {
  sceneRoot.position.set(0, 0, 0);
  sceneRoot.rotation.set(0, 0, 0);
  sceneRoot.scale.setScalar(1);
  camera.position.set(0, 0, 4.8);
  controls.target.set(0, 0, 0);
  controls.update();
}

async function loadConnectivityData() {
  els.connectivitySummary.classList.add('hidden');
  try {
    state.connectivity = await fetchConnectivity();
    const edges = state.connectivity.edges;
    const totalWeight = edges.reduce((sum, e) => sum + e.weight, 0);
    els.connectivitySummary.innerHTML = `<strong>${state.connectivity.dataset || DATASET}</strong><br>${edges.length.toLocaleString('en-US')} exported neuron-to-neuron edges · total weight ${totalWeight.toLocaleString('en-US')}<br><span class="muted">The browser does not infer missing edges.</span>`;
    els.connectivitySummary.classList.remove('hidden');
    els.applyConnectivity.disabled = !els.seedSelect.options.length;
    setStatus('Authoritative connectivity export loaded from data/connectivity.json.');
  } catch (error) {
    state.connectivity = null;
    els.connectivitySummary.innerHTML = `<strong>No local connectivity export yet.</strong><br>Run <code>python scripts/export_subset.py</code> with a neuPrint token. Credentials remain outside the frontend.`;
    els.connectivitySummary.classList.remove('hidden');
    els.applyConnectivity.disabled = true;
    setStatus(error.message);
  }
}

function renderPartnerList(rows) {
  els.partnerList.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'mini-card';
    empty.textContent = 'No exported partners pass the current filter.';
    els.partnerList.appendChild(empty);
    return;
  }
  for (const row of rows.slice(0, 100)) {
    const button = document.createElement('button');
    button.className = 'partner-button';
    button.innerHTML = `<span class="partner-name"></span><strong class="partner-weight"></strong><span class="partner-id"></span><span class="partner-direction"></span>`;
    button.querySelector('.partner-name').textContent = labelForPartner(row);
    button.querySelector('.partner-weight').textContent = row.weight.toLocaleString('en-US');
    button.querySelector('.partner-id').textContent = `bodyId ${row.bodyId}`;
    button.querySelector('.partner-direction').textContent = row.direction;
    button.addEventListener('click', async () => {
      try {
        await loadBody(row.bodyId, { select: true });
        setStatus(`${row.direction} partner ${labelForPartner(row)} loaded · weight ${row.weight}.`);
      } catch (error) {
        console.error(error);
        setStatus(`Could not load partner ${row.bodyId}: ${error.message}`);
      }
    });
    els.partnerList.appendChild(button);
  }
  if (rows.length > 100) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = `Showing first 100 of ${rows.length.toLocaleString('en-US')} matching partners for mobile usability.`;
    els.partnerList.appendChild(note);
  }
}

function applyConnectivityFilter() {
  if (!state.connectivity) return;
  const seed = els.seedSelect.value;
  const rows = partnersForSeed(state.connectivity, seed, els.directionSelect.value, els.minWeight.value);
  renderPartnerList(rows);
  selectBody(seed);
  const weight = rows.reduce((sum, row) => sum + row.weight, 0);
  setStatus(`${rows.length} exported partner connection(s) match the filter · summed weight ${weight.toLocaleString('en-US')}.`);
}

async function enterAR() {
  if (!state.loaded.size) await loadDefaultPair();
  await handAR.start();
  state.arMode = true;
  document.body.classList.add('ar', 'panel-collapsed');
  renderer.setClearColor(0x000000, 0);
  grid.visible = false;
  controls.enabled = false;
  els.toggleAR.disabled = true;
  els.exitAR.disabled = false;
  els.arHelp.classList.remove('hidden');
  setTimeout(() => els.arHelp.classList.add('hidden'), 3500);
}

function exitAR() {
  state.arMode = false;
  handAR.stop();
  document.body.classList.remove('ar');
  renderer.setClearColor(0x05070b, 1);
  grid.visible = true;
  controls.enabled = true;
  els.toggleAR.disabled = false;
  els.exitAR.disabled = true;
  fitView();
  setStatus('Interactive 3D mode active.');
}

function updateFPS(now) {
  state.fpsTimes.push(now);
  const cutoff = now - 1000;
  while (state.fpsTimes.length && state.fpsTimes[0] < cutoff) state.fpsTimes.shift();
  els.fps.textContent = state.fpsTimes.length > 1 ? String(state.fpsTimes.length - 1) : '—';
}

function animate(now = 0) {
  requestAnimationFrame(animate);
  updateFPS(now);
  if (state.autoRotate && !state.arMode) sceneRoot.rotation.y += 0.0035;
  if (state.arMode) handAR.update(now);
  else controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, DISPLAY.maxDevicePixelRatio));
  renderer.setSize(innerWidth, innerHeight);
});

els.loadBody.addEventListener('click', async () => {
  try { await loadBody(els.bodyId.value, { select: true }); }
  catch (error) { console.error(error); setStatus(`Error: ${error.message}`); }
});
els.loadPair.addEventListener('click', async () => {
  try { await loadDefaultPair(); }
  catch (error) { console.error(error); setStatus(`Could not load MaleCNS skeletons: ${error.message}`); }
});
els.clearScene.addEventListener('click', resetSceneData);
els.fitView.addEventListener('click', fitView);
els.toggleRotate.addEventListener('click', () => {
  state.autoRotate = !state.autoRotate;
  setStatus(`Auto-rotation ${state.autoRotate ? 'enabled' : 'disabled'}.`);
});
els.toggleAR.addEventListener('click', async () => {
  try { await enterAR(); }
  catch (error) { console.error(error); setStatus(`Could not start camera AR: ${error.message}`); }
});
els.exitAR.addEventListener('click', exitAR);
els.loadConnectivity.addEventListener('click', loadConnectivityData);
els.applyConnectivity.addEventListener('click', applyConnectivityFilter);
els.seedSelect.addEventListener('change', applyConnectivityFilter);
els.directionSelect.addEventListener('change', applyConnectivityFilter);
els.minWeight.addEventListener('input', () => {
  els.minWeightValue.value = els.minWeight.value;
  els.minWeightValue.textContent = els.minWeight.value;
});
els.minWeight.addEventListener('change', applyConnectivityFilter);
els.panelToggle.addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('panel-collapsed');
  els.panelToggle.setAttribute('aria-expanded', String(!collapsed));
});

setStatus(`Male Fly Connectome AR v${APP_VERSION} initializing…`);
setDataBadge('data: loading…');
animate();
loadDefaultPair().catch((error) => {
  console.error(error);
  setDataBadge('data: unavailable');
  setStatus('Interface ready, but direct SWC loading failed. Generate local authoritative files with scripts/export_subset.py.');
});
