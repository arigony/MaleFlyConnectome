export async function fetchConnectivity(path = './data/connectivity.json') {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Connectivity export unavailable (HTTP ${r.status}).`);
  const data = await r.json();
  if (!data || !Array.isArray(data.edges)) throw new Error('Connectivity JSON is missing an edges array.');
  return normalizeConnectivity(data);
}

export function normalizeConnectivity(data) {
  const edges = data.edges.map((e) => {
    const weight = Number(e.weight);
    if (!Number.isFinite(weight) || weight < 0) throw new Error('Connectivity contains an invalid weight.');
    return {
      bodyId_pre: String(e.bodyId_pre),
      bodyId_post: String(e.bodyId_post),
      weight,
      type_pre: e.type_pre ?? null,
      type_post: e.type_post ?? null,
      instance_pre: e.instance_pre ?? null,
      instance_post: e.instance_post ?? null
    };
  });
  return { ...data, edges };
}

export function partnersForSeed(data, seedBodyId, direction = 'both', minWeight = 1) {
  const seed = String(seedBodyId);
  const threshold = Math.max(1, Number(minWeight) || 1);
  const rows = [];

  for (const e of data.edges) {
    if ((direction === 'both' || direction === 'downstream') && e.bodyId_pre === seed && e.weight >= threshold) {
      rows.push({
        bodyId: e.bodyId_post,
        weight: e.weight,
        direction: 'downstream',
        type: e.type_post,
        instance: e.instance_post
      });
    }
    if ((direction === 'both' || direction === 'upstream') && e.bodyId_post === seed && e.weight >= threshold) {
      rows.push({
        bodyId: e.bodyId_pre,
        weight: e.weight,
        direction: 'upstream',
        type: e.type_pre,
        instance: e.instance_pre
      });
    }
  }

  const merged = new Map();
  for (const row of rows) {
    const key = `${row.direction}:${row.bodyId}`;
    const previous = merged.get(key);
    if (!previous || row.weight > previous.weight) merged.set(key, row);
  }

  return [...merged.values()].sort((a, b) => b.weight - a.weight || a.bodyId.localeCompare(b.bodyId));
}

export function labelForPartner(row) {
  return row.instance || row.type || `body ${row.bodyId}`;
}
