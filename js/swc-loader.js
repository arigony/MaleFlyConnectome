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

export async function fetchSkeleton(bodyId, { signal } = {}) {
  bodyId = String(bodyId).trim();
  if (!/^\d+$/.test(bodyId)) throw new Error('bodyId must be numeric.');

  const localUrl = `./data/skeletons/${encodeURIComponent(bodyId)}.json`;
  try {
    const rLocal = await fetch(localUrl, { cache: 'no-store', signal });
    if (rLocal.ok) {
      const parsed = validateLocalSkeleton(await rLocal.json(), bodyId);
      if (parsed) return parsed;
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  }

  const remoteUrl = `${SWC_BASE}${encodeURIComponent(bodyId)}.swc`;
  const r = await fetch(remoteUrl, { signal });
  if (!r.ok) throw new Error(`Skeleton ${bodyId}: HTTP ${r.status}`);
  return parseSWC(await r.text(), bodyId, OFFICIAL_EXAMPLES[bodyId], remoteUrl);
}

export function countSegments(skeleton) {
  const ids = new Set(skeleton.nodes.map((n) => n.id));
  return skeleton.nodes.reduce((count, n) => count + (ids.has(n.parent) ? 1 : 0), 0);
}
