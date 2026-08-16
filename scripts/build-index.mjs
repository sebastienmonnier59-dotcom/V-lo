/**
 * Transforme les données brutes en artefacts consommables par le site :
 *
 *  - un réseau affichable (GeoJSON allégé)
 *  - un graphe routable compact, calculé une fois ici plutôt qu'à chaque visite
 *  - un index des gares rattachées au réseau
 *
 * L'idée directrice : le navigateur doit pouvoir répondre à « depuis cette gare,
 * où puis-je aller en 40 km de voie verte ouverte et lisse ? » sans serveur.
 * Tout le travail lourd (topologie, rattachement) se fait donc au build.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { haversine, lineLength, clean } from './lib/util.mjs';

const RAW = new URL('../data/raw/', import.meta.url);
const OUT = new URL('../web/data/', import.meta.url);

// Deux extrémités distantes de moins de 20 m décrivent la même intersection.
// Les jeux de données publics ne garantissent pas des coordonnées identiques.
const SNAP_M = 20;
const GRID = 0.00025; // ≈ 28 m en longitude sous nos latitudes
// Au-delà de 3 km à pied/vélo depuis la gare, l'accroche n'a plus de sens pratique.
const STATION_MAX_ACCESS_M = 3000;

async function readJson(name, optional = false) {
  const url = new URL(name, RAW);
  if (!existsSync(url)) {
    if (optional) return null;
    throw new Error(`Fichier manquant : data/raw/${name} — lancez d'abord le fetch correspondant.`);
  }
  return JSON.parse(await readFile(url, 'utf8'));
}

/**
 * Indexe des points sur une grille pour retrouver les voisins proches
 * sans comparer tout le monde à tout le monde.
 */
class GridIndex {
  constructor(cell = GRID) {
    this.cell = cell;
    this.buckets = new Map();
  }
  key(lon, lat) {
    return `${Math.floor(lon / this.cell)}|${Math.floor(lat / this.cell)}`;
  }
  add(lon, lat, value) {
    const k = this.key(lon, lat);
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = []));
    b.push({ lon, lat, value });
  }
  near(lon, lat, radiusCells = 1) {
    const cx = Math.floor(lon / this.cell);
    const cy = Math.floor(lat / this.cell);
    const out = [];
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        const b = this.buckets.get(`${cx + dx}|${cy + dy}`);
        if (b) out.push(...b);
      }
    }
    return out;
  }
}

/**
 * Découpe les tronçons là où ils devraient former une intersection.
 *
 * Les jeux de données décrivent des tronçons, pas un graphe : une antenne qui
 * rejoint une véloroute en plein milieu d'un tronçon partage ses coordonnées
 * avec l'un de ses sommets, mais aucune extrémité commune. Sans ce découpage,
 * le calcul d'itinéraire croit à un cul-de-sac là où il y a une bifurcation —
 * c'est exactement ce qui isolait la gare de Namur du réseau de la Meuse.
 *
 * On découpe aussi aux points d'accroche des gares, pour qu'une gare bordant
 * le milieu d'un halage s'y rattache vraiment, et non à 3 km de là.
 */
function splitAtJunctions(features, stations) {
  const endpoints = new GridIndex();
  features.forEach((f, i) => {
    const c = f.geometry.coordinates;
    endpoints.add(c[0][0], c[0][1], i);
    endpoints.add(c[c.length - 1][0], c[c.length - 1][1], i);
  });

  const cuts = new Map(); // index du tronçon → ensemble de positions de sommets

  const requestCut = (segIndex, vertexIndex, vertexCount) => {
    if (vertexIndex <= 0 || vertexIndex >= vertexCount - 1) return;
    let set = cuts.get(segIndex);
    if (!set) cuts.set(segIndex, (set = new Set()));
    set.add(vertexIndex);
  };

  // (a) Intersections en T : une extrémité tombe au milieu d'un autre tronçon.
  features.forEach((f, i) => {
    const coords = f.geometry.coordinates;
    for (let v = 1; v < coords.length - 1; v++) {
      const [lon, lat] = coords[v];
      for (const cand of endpoints.near(lon, lat)) {
        if (cand.value === i) continue;
        if (haversine([lon, lat], [cand.lon, cand.lat]) <= SNAP_M) {
          requestCut(i, v, coords.length);
          break;
        }
      }
    }
  });

  // (b) Points d'accroche des gares.
  const vertices = new GridIndex(0.01);
  features.forEach((f, i) => {
    f.geometry.coordinates.forEach(([lon, lat], v) => vertices.add(lon, lat, { i, v }));
  });
  for (const s of stations.features) {
    const [lon, lat] = s.geometry.coordinates;
    let best = null;
    let bestDist = Infinity;
    for (const cand of vertices.near(lon, lat, 3)) {
      const d = haversine([lon, lat], [cand.lon, cand.lat]);
      if (d < bestDist) {
        bestDist = d;
        best = cand.value;
      }
    }
    if (best && bestDist <= STATION_MAX_ACCESS_M) {
      requestCut(best.i, best.v, features[best.i].geometry.coordinates.length);
    }
  }

  // Application des découpes : un tronçon coupé devient plusieurs tronçons
  // qui gardent ses attributs, avec une longueur recalculée.
  const out = [];
  features.forEach((f, i) => {
    const positions = cuts.get(i);
    if (!positions?.size) {
      out.push(f);
      return;
    }
    const coords = f.geometry.coordinates;
    const bounds = [0, ...[...positions].sort((a, b) => a - b), coords.length - 1];
    for (let k = 0; k < bounds.length - 1; k++) {
      const slice = coords.slice(bounds[k], bounds[k + 1] + 1);
      if (slice.length < 2) continue;
      out.push({
        type: 'Feature',
        properties: {
          ...f.properties,
          id: `${f.properties.id}#${k}`,
          len: Math.round(lineLength(slice)),
        },
        geometry: { type: 'LineString', coordinates: slice },
      });
    }
  });

  console.log(`  découpage : ${features.length} → ${out.length} tronçons (${cuts.size} tronçons coupés)`);
  return out;
}

/** Construit la topologie : chaque tronçon devient une arête entre deux nœuds. */
function buildGraph(features) {
  const nodes = [];
  const index = new GridIndex();

  const nodeAt = (lon, lat) => {
    for (const cand of index.near(lon, lat)) {
      if (haversine([lon, lat], [cand.lon, cand.lat]) <= SNAP_M) return cand.value;
    }
    const id = nodes.length;
    nodes.push([Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
    index.add(lon, lat, id);
    return id;
  };

  const edges = [];
  features.forEach((f, i) => {
    const c = f.geometry.coordinates;
    const a = nodeAt(c[0][0], c[0][1]);
    const b = nodeAt(c[c.length - 1][0], c[c.length - 1][1]);
    if (a === b) return; // boucle dégénérée : sans intérêt pour le calcul d'itinéraire
    edges.push({
      a,
      b,
      len: f.properties.len || Math.round(lineLength(c)),
      seg: i,
      status: f.properties.status,
      surface: f.properties.surface,
      kind: f.properties.kind,
    });
  });

  return { nodes, edges };
}

/** Taille de la plus grande composante connexe — un bon indicateur de qualité topologique. */
function componentStats(nodes, edges) {
  const adj = Array.from({ length: nodes.length }, () => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const seen = new Uint8Array(nodes.length);
  let biggest = 0;
  let count = 0;
  for (let s = 0; s < nodes.length; s++) {
    if (seen[s]) continue;
    count++;
    let size = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const n = stack.pop();
      size++;
      for (const m of adj[n]) {
        if (!seen[m]) {
          seen[m] = 1;
          stack.push(m);
        }
      }
    }
    biggest = Math.max(biggest, size);
  }
  return { components: count, biggest };
}

/** Rattache chaque gare au nœud du réseau le plus proche, si elle est assez près. */
function attachStations(stations, nodes) {
  // Grille large : on cherche jusqu'à 3 km, soit une dizaine de cellules.
  const index = new GridIndex(0.01); // ≈ 1,1 km
  nodes.forEach(([lon, lat], id) => index.add(lon, lat, id));

  const attached = [];
  for (const s of stations.features) {
    const [lon, lat] = s.geometry.coordinates;
    let best = null;
    let bestDist = Infinity;
    for (const cand of index.near(lon, lat, 3)) {
      const d = haversine([lon, lat], [cand.lon, cand.lat]);
      if (d < bestDist) {
        bestDist = d;
        best = cand.value;
      }
    }
    if (best === null || bestDist > STATION_MAX_ACCESS_M) continue;
    attached.push({
      id: s.properties.id,
      name: s.properties.name,
      country: s.properties.country,
      commune: s.properties.commune ?? null,
      lon,
      lat,
      node: best,
      access: Math.round(bestDist),
    });
  }
  attached.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return attached;
}

/** Agrège les tronçons par itinéraire nommé, pour l'index consultable du site. */
function buildRouteIndex(features) {
  const byKey = new Map();
  for (const f of features) {
    const p = f.properties;
    // Deuxième filet après `clean` côté collecte : un identifiant vide ne doit
    // jamais devenir une clé de regroupement.
    const key = clean(p.ref) || clean(p.name);
    if (!key) continue;
    let r = byKey.get(key);
    if (!r) {
      byKey.set(
        key,
        (r = {
          key,
          ref: p.ref ?? null,
          name: p.name ?? null,
          country: p.country,
          network: p.network ?? null,
          len: 0,
          openLen: 0,
          smoothLen: 0,
          greenLen: 0,
          segments: 0,
          bbox: [Infinity, Infinity, -Infinity, -Infinity],
        }),
      );
    }
    r.len += p.len;
    if (p.status === 'open') r.openLen += p.len;
    if (p.surface === 'smooth') r.smoothLen += p.len;
    if (p.kind === 'Voie verte' || p.kind === 'RAVeL') r.greenLen += p.len;
    r.segments++;
    for (const [lon, lat] of f.geometry.coordinates) {
      if (lon < r.bbox[0]) r.bbox[0] = lon;
      if (lat < r.bbox[1]) r.bbox[1] = lat;
      if (lon > r.bbox[2]) r.bbox[2] = lon;
      if (lat > r.bbox[3]) r.bbox[3] = lat;
    }
  }
  return [...byKey.values()]
    .map((r) => ({ ...r, bbox: r.bbox.map((v) => Number(v.toFixed(4))) }))
    .sort((a, b) => b.len - a.len);
}

/** Ne conserve que ce que la carte et les filtres utilisent réellement. */
function slimFeature(f, i) {
  const p = f.properties;
  return {
    type: 'Feature',
    properties: {
      i,
      id: p.id,
      n: p.name,
      r: p.ref,
      k: p.kind,
      s: p.status,
      sf: p.surface,
      st: p.surfaceType,
      sg: p.signed,
      w: p.width,
      l: p.len,
      c: p.country,
      net: p.network ?? null,
    },
    geometry: f.geometry,
  };
}

async function main() {
  const ravel = await readJson('ravel-segments.geojson');
  const france = await readJson('france-routes.geojson', true);
  const stations = await readJson('stations.geojson');

  if (!france) {
    console.warn('  ! france-routes.geojson absent : build limité à la Wallonie');
  }

  const collected = [...ravel.features, ...(france?.features ?? [])];
  console.log(`Réseau : ${collected.length} tronçons collectés`);

  const features = splitAtJunctions(collected, stations);
  const slim = features.map(slimFeature);
  const { nodes, edges } = buildGraph(features);
  const stats = componentStats(nodes, edges);
  console.log(
    `  graphe : ${nodes.length} nœuds, ${edges.length} arêtes, ` +
      `${stats.components} composantes (la plus grande : ${stats.biggest} nœuds)`,
  );

  const attached = attachStations(stations, nodes);
  console.log(
    `  gares : ${attached.length}/${stations.features.length} rattachées à moins de ${STATION_MAX_ACCESS_M / 1000} km du réseau`,
  );

  const routes = buildRouteIndex(features);
  const totalKm = features.reduce((s, f) => s + f.properties.len, 0) / 1000;
  const openKm =
    features.filter((f) => f.properties.status === 'open').reduce((s, f) => s + f.properties.len, 0) /
    1000;

  await mkdir(OUT, { recursive: true });
  await writeFile(
    new URL('network.geojson', OUT),
    JSON.stringify({ type: 'FeatureCollection', features: slim }),
  );
  await writeFile(
    new URL('graph.json', OUT),
    JSON.stringify({
      nodes,
      // Format tabulaire compact : [a, b, longueur, indexTronçon] × N
      edges: edges.map((e) => [e.a, e.b, e.len, e.seg]),
    }),
  );
  await writeFile(new URL('stations.json', OUT), JSON.stringify(attached));
  await writeFile(new URL('routes.json', OUT), JSON.stringify(routes));
  await writeFile(
    new URL('meta.json', OUT),
    JSON.stringify({
      builtAt: new Date().toISOString().slice(0, 10),
      segments: features.length,
      totalKm: Math.round(totalKm),
      openKm: Math.round(openKm),
      stations: attached.length,
      routes: routes.length,
      graph: { nodes: nodes.length, edges: edges.length, ...stats },
      countries: {
        BE: features.filter((f) => f.properties.country === 'BE').length,
        FR: features.filter((f) => f.properties.country === 'FR').length,
      },
    }),
  );

  console.log(`  → ${Math.round(totalKm)} km au total, ${Math.round(openKm)} km ouverts`);
  console.log('  écrit web/data/{network.geojson,graph.json,stations.json,routes.json,meta.json}');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
