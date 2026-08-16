// Petites fonctions partagées par les scripts de collecte.

/** Récupère une URL avec retries + backoff exponentiel. */
export async function fetchRetry(url, options = {}, tries = 5) {
  let wait = 2000;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res;
    } catch (err) {
      if (attempt === tries) throw err;
      console.warn(`  ! ${err.message} — retry ${attempt}/${tries - 1} dans ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

/** Distance haversine en mètres. */
export function haversine(a, b) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Longueur d'une LineString en mètres. */
export function lineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

/**
 * Simplification Douglas-Peucker sur des coordonnées lon/lat.
 * `tolerance` est exprimée en mètres (approximée en degrés localement).
 */
export function simplify(coords, toleranceMeters) {
  if (coords.length <= 2) return coords;
  const latRad = (coords[0][1] * Math.PI) / 180;
  const degPerMeterLat = 1 / 111320;
  const degPerMeterLon = 1 / (111320 * Math.max(0.2, Math.cos(latRad)));
  const tol = toleranceMeters * Math.max(degPerMeterLat, degPerMeterLon);
  const tol2 = tol * tol;

  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDistSq(coords[i], coords[first], coords[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tol2 && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

function segDistSq(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Arrondit les coordonnées à N décimales (≈1 m à 5 décimales). */
export function roundCoords(coords, decimals = 5) {
  const f = 10 ** decimals;
  return coords.map(([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f]);
}

export function fmtKm(meters) {
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Normalise un champ texte venu d'une base tierce.
 * Les exports du SPW contiennent des chaînes réduites à une espace : sans ce
 * nettoyage, elles passent pour des valeurs et agrègent 1 444 tronçons sans
 * rapport sous un même « itinéraire ».
 */
export function clean(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
