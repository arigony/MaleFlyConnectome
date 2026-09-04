import { OFFICIAL_EXAMPLES, SWC_BASE } from './config.js';

function finiteNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value for ${name}.`);
  return n;
}

export function parseSWC(text, bodyId, label = null, source = 'remote-swc') {
  const nodes = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split(/\s+/);
    if (p.length < 7) continue;
    nodes.push({
      id: finiteNumber(p[0], 'row id'),
      type: finiteNumber(p[1], 'node type'),
      x: finiteNumber(p[2], 'x'),
      y: finiteNumber(p[3], 'y'),
      z: finiteNumber(p[4], 'z'),
      r: finiteNumber(p[5], 'radius'),
      parent: finiteNumber(p[6], 'parent')
    });
  }
  if (!nodes.length) throw new Error(`SWC ${bodyId} contained no valid nodes.`);
  return {
    bodyId: String(bodyId),
    label: label || OFFICIAL_EXAMPLES[String(bodyId)] || `body ${bodyId}`,
    coordinate_space: 'MaleCNS EM skeleton coordinates',
    source_units: '8 nm units',
    source,
    nodes
  };
}

function validateLocalSkeleton(data, expectedBodyId) {
  if (!data || !Array.isArray(data.nodes) || !data.nodes.length) return null;
  const bodyId = String(data.bodyId ?? expectedBodyId);
  if (bodyId !== String(expectedBodyId)) throw new Error(`Local skeleton bodyId mismatch: expected ${expectedBodyId}, got ${bodyId}.`);
  const nodes = data.nodes.map((n) => ({
    id: finiteNumber(n.id, 'id'),
    type: finiteNumber(n.type ?? 0, 'type'),
    x: finiteNumber(n.x, 'x'),
    y: finiteNumber(n.y, 'y'),
    z: finiteNumber(n.z, 'z'),
    r: finiteNumber(n.r ?? 0, 'r'),
    parent: finiteNumber(n.parent, 'parent')
  }));
  return { ...data, bodyId, nodes, source: 'local-export' };
}

async function tryLocalJson(bodyId, signal) {
  const url = `./data/skeletons/${encodeURIComponent(bodyId)}.json`;
  try {
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) return null;
    return validateLocalSkeleton(await response.json(), bodyId);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

async function tryLocalSwc(bodyId, signal) {
  const url = `./data/skeletons/${encodeURIComponent(bodyId)}.swc`;
  try {
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) return null;
    return parseSWC(await response.text(), bodyId, OFFICIAL_EXAMPLES[bodyId], 'local-export');
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

export async function fetchSkeleton(bodyId, { signal } = {}) {
  bodyId = String(bodyId).trim();
  if (!/^\d+$/.test(bodyId)) throw new Error('bodyId must be numeric.');

  // Reproducible publication/demo path: prefer data pinned in this repository.
  // This avoids depending on cross-origin bucket configuration in the browser.
  const localJson = await tryLocalJson(bodyId, signal);
  if (localJson) return localJson;

  const localSwc = await tryLocalSwc(bodyId, signal);
  if (localSwc) return localSwc;

  // Convenience fallback for arbitrary body IDs. This can fail in browsers if
  // the upstream bucket does not expose a compatible CORS policy.
  const remoteUrl = `${SWC_BASE}${encodeURIComponent(bodyId)}.swc`;
  let response;
  try {
    response = await fetch(remoteUrl, { signal, mode: 'cors' });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(`Skeleton ${bodyId} is not bundled locally and direct MaleCNS loading was blocked by the browser. Export/cache it locally for reproducible use.`);
  }
  if (!response.ok) throw new Error(`Skeleton ${bodyId}: HTTP ${response.status}`);
  return parseSWC(await response.text(), bodyId, OFFICIAL_EXAMPLES[bodyId], remoteUrl);
}

export function countSegments(skeleton) {
  const ids = new Set(skeleton.nodes.map((n) => n.id));
  return skeleton.nodes.reduce((count, n) => count + (ids.has(n.parent) ? 1 : 0), 0);
}
