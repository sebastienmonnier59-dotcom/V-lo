/**
 * Récupère les véloroutes nationales (ncn) et internationales / EuroVelo (icn)
 * de France depuis OpenStreetMap via l'API Overpass.
 *
 * Source  : OpenStreetMap contributors — https://www.openstreetmap.org
 * Licence : ODbL 1.0
 *
 * Pourquoi OSM plutôt que l'ON3V ? Le jeu ON3V publié sur data.gouv.fr date de
 * 2017 et n'est plus tenu à jour ; OSM couvre le même réseau (V-numbers,
 * EuroVelo, voies vertes) avec une fraîcheur de quelques jours.
 *
 * Le service Overpass renvoie régulièrement des 504 : ce script tourne par lots,
 * change de miroir, réessaie, et met en cache chaque lot sur disque pour être
 * relançable sans tout refaire.
 *
 * Sortie : data/raw/france-routes.geojson (schéma normalisé V-lo)
 */
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { lineLength, simplify, roundCoords } from './lib/util.mjs';

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];
const BATCH = 12;
const CACHE = new URL('../data/cache/', import.meta.url);
const RAW = new URL('../data/raw/', import.meta.url);

let mirrorIndex = 0;

async function overpass(query, label) {
  let wait = 3000;
  for (let attempt = 0; attempt < MIRRORS.length * 3; attempt++) {
    const mirror = MIRRORS[mirrorIndex % MIRRORS.length];
    mirrorIndex++;
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'V-lo/0.1 (open data cycling map; github.com/sebastienmonnier59-dotcom/v-lo)',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim().startsWith('{')) throw new Error('réponse non-JSON (serveur occupé)');
      const data = JSON.parse(text);
      // Overpass répond parfois 200 avec un corps JSON vide et un `remark`
      // d'erreur : sans ce garde-fou, on mettrait ce vide en cache pour de bon.
      if (data.remark) throw new Error(`remark Overpass : ${data.remark}`);
      if (!Array.isArray(data.elements) || data.elements.length === 0) {
        throw new Error('résultat vide (probable timeout côté serveur)');
      }
      return data;
    } catch (err) {
      console.warn(`  ! ${label}: ${err.message} (${new URL(mirror).host}) — retry dans ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 60_000);
    }
  }
  throw new Error(`${label}: tous les miroirs Overpass ont échoué`);
}

/** Les tags OSM de surface, ramenés au même vocabulaire que les données RAVeL. */
const SMOOTH = new Set(['asphalt', 'paved', 'concrete', 'paving_stones', 'concrete:plates']);
const ROUGH = new Set(['compacted', 'fine_gravel', 'sett', 'cobblestone', 'unhewn_cobblestone', 'metal', 'wood']);
const LOOSE = new Set(['gravel', 'ground', 'dirt', 'earth', 'grass', 'sand', 'mud', 'pebblestone', 'unpaved']);

function surfaceOf(tags = {}) {
  const s = tags.surface;
  if (!s) return null;
  if (SMOOTH.has(s)) return 'smooth';
  if (ROUGH.has(s)) return 'rough';
  if (LOOSE.has(s)) return 'loose';
  return null;
}

/**
 * Une voie verte au sens français : site propre interdit aux véhicules à moteur.
 * On l'infère des tags OSM plutôt que de faire confiance au seul nom.
 */
function kindOf(tags = {}) {
  if (tags.highway === 'cycleway') return 'Voie verte';
  if (tags.highway === 'path' && tags.bicycle === 'designated') return 'Voie verte';
  if (tags.highway === 'footway' && tags.bicycle === 'designated') return 'Voie verte';
  if (tags.highway === 'track') return 'Chemin';
  if (tags.highway === 'pedestrian' || tags.highway === 'living_street')
    return 'Itinéraire à circulation apaisée';
  if (tags.highway) return 'Route';
  return null;
}

/**
 * Recolle les ways consécutifs d'un itinéraire en polylignes continues.
 *
 * Une relation OSM comme « La Loire à Vélo » compte plusieurs centaines de ways
 * de quelques dizaines de mètres. Les garder tels quels donnerait des centaines
 * de milliers d'objets à charger dans le navigateur, pour un tracé identique.
 */
function stitch(parts) {
  const lines = [];
  let current = null;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];

  for (const coords of parts) {
    if (!current) {
      current = coords.slice();
      continue;
    }
    const tail = current[current.length - 1];
    if (same(tail, coords[0])) {
      current.push(...coords.slice(1));
    } else if (same(tail, coords[coords.length - 1])) {
      // Le way suivant est décrit dans le sens inverse : on le retourne.
      current.push(...coords.slice(0, -1).reverse());
    } else {
      lines.push(current);
      current = coords.slice();
    }
  }
  if (current) lines.push(current);
  return lines;
}

function normalizeRelation(rel, seenWays) {
  const t = rel.tags ?? {};

  // Un même way appartient souvent à plusieurs relations (une véloroute et
  // l'EuroVelo qui l'emprunte). On ne le garde qu'une fois.
  const parts = [];
  for (const member of rel.members ?? []) {
    if (member.type !== 'way' || !Array.isArray(member.geometry)) continue;
    if (seenWays.has(member.ref)) continue;
    seenWays.add(member.ref);
    const coords = member.geometry
      .filter((p) => p && typeof p.lon === 'number')
      .map((p) => [p.lon, p.lat]);
    if (coords.length >= 2) parts.push(coords);
  }

  // `out geom` sur une relation ne renvoie pas les tags des ways membres :
  // la surface vient donc de la relation quand elle est renseignée, sinon null.
  return stitch(parts).map((coords, part) => ({
    type: 'Feature',
    properties: {
      id: `fr-${rel.id}-${part}`,
      src: 'osm',
      country: 'FR',
      region: null,
      routeId: rel.id,
      name: t.name || null,
      ref: t.ref || null,
      network: t.network || null,
      operator: t.operator || null,
      kind: kindOf(t),
      // OSM distingue les itinéraires en projet via `state=proposed`.
      status: t.state === 'proposed' ? 'planned' : 'open',
      statusLabel: t.state === 'proposed' ? 'Projet' : 'Ouvert',
      surface: surfaceOf(t),
      surfaceType: t.surface || null,
      signed: t.signage === 'yes' ? true : null,
      oneway: false,
      width: null,
      website: t.website || null,
      len: Math.round(lineLength(coords)),
    },
    geometry: { type: 'LineString', coordinates: roundCoords(simplify(coords, 8)) },
  }));
}

async function listRelations() {
  const cached = new URL('france-relations.json', CACHE);
  if (existsSync(cached)) {
    console.log('  liste des relations : cache');
    return JSON.parse(await readFile(cached, 'utf8'));
  }
  const data = await overpass(
    `[out:json][timeout:180];
     area["ISO3166-1"="FR"][admin_level=2]->.fr;
     relation["route"="bicycle"]["network"~"^(icn|ncn)$"](area.fr);
     out ids tags;`,
    'liste des relations',
  );
  const ids = data.elements.map((e) => e.id);
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, JSON.stringify(ids));
  return ids;
}

async function fetchBatch(ids, index) {
  const cached = new URL(`france-batch-${index}.json`, CACHE);
  if (existsSync(cached)) return JSON.parse(await readFile(cached, 'utf8'));
  const data = await overpass(
    `[out:json][timeout:280];rel(id:${ids.join(',')});out geom;`,
    `lot ${index}`,
  );
  await writeFile(cached, JSON.stringify(data.elements ?? []));
  return data.elements ?? [];
}

async function main() {
  console.log('France — véloroutes nationales & EuroVelo (OpenStreetMap, ODbL)');
  await mkdir(CACHE, { recursive: true });
  await mkdir(RAW, { recursive: true });

  const ids = await listRelations();
  console.log(`  ${ids.length} itinéraires ncn/icn en France`);

  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));

  const features = [];
  const seenWays = new Set();
  for (const [i, batch] of batches.entries()) {
    const elements = await fetchBatch(batch, i);
    for (const rel of elements) {
      if (rel.type === 'relation') features.push(...normalizeRelation(rel, seenWays));
    }
    const km = features.reduce((s, f) => s + f.properties.len, 0) / 1000;
    console.log(`  lot ${i + 1}/${batches.length} — ${features.length} tronçons, ${km.toFixed(0)} km`);
  }

  await writeFile(
    new URL('france-routes.geojson', RAW),
    JSON.stringify({ type: 'FeatureCollection', features }),
  );
  console.log(`  écrit data/raw/france-routes.geojson (${features.length} tronçons)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
