/**
 * Complète les tronçons français avec le revêtement et le type de voie.
 *
 * Pourquoi une seconde passe ? `out geom` sur une relation OpenStreetMap rend
 * la géométrie de ses ways membres mais pas leurs tags, et les tags utiles
 * (`surface`, `highway`, `bicycle`) vivent sur les ways, presque jamais sur la
 * relation. Sans cette passe, tous les itinéraires français affichent un
 * revêtement inconnu et aucune voie verte — les filtres deviennent inutilisables
 * hors de Wallonie.
 *
 * La requête ne demande que des tags, sans géométrie : elle est bien plus légère
 * que la collecte principale.
 *
 * Entrée / sortie : data/raw/france-routes.geojson (réécrit sur place)
 */
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];
const WAYS_PER_QUERY = 400;
const CACHE = new URL('../data/cache/', import.meta.url);
const ROUTES = new URL('../data/raw/france-routes.geojson', import.meta.url);

const SMOOTH = new Set(['asphalt', 'paved', 'concrete', 'paving_stones', 'concrete:plates']);
const ROUGH = new Set(['compacted', 'fine_gravel', 'sett', 'cobblestone', 'unhewn_cobblestone', 'metal', 'wood']);
const LOOSE = new Set(['gravel', 'ground', 'dirt', 'earth', 'grass', 'sand', 'mud', 'pebblestone', 'unpaved']);

const SURFACE_RANK = { smooth: 0, rough: 1, loose: 2 };

function surfaceOf(tags) {
  const s = tags.surface;
  if (!s) return null;
  if (SMOOTH.has(s)) return 'smooth';
  if (ROUGH.has(s)) return 'rough';
  if (LOOSE.has(s)) return 'loose';
  return null;
}

function kindOf(tags) {
  if (tags.highway === 'cycleway') return 'Voie verte';
  if ((tags.highway === 'path' || tags.highway === 'footway') && tags.bicycle === 'designated') {
    return 'Voie verte';
  }
  if (tags.highway === 'track') return 'Chemin';
  if (tags.highway === 'pedestrian' || tags.highway === 'living_street') {
    return 'Itinéraire à circulation apaisée';
  }
  if (tags.highway) return 'Route';
  return null;
}

let mirrorIndex = 0;

async function overpass(query, label) {
  let wait = 3000;
  for (let attempt = 0; attempt < MIRRORS.length * 2; attempt++) {
    const mirror = MIRRORS[mirrorIndex++ % MIRRORS.length];
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
      if (data.remark) throw new Error(`remark Overpass : ${data.remark}`);
      if (!Array.isArray(data.elements)) throw new Error('réponse inattendue');
      return data.elements;
    } catch (err) {
      console.warn(`  ! ${label}: ${err.message} (${new URL(mirror).host}) — retry dans ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 60_000);
    }
  }
  throw new Error(`${label}: tous les miroirs Overpass ont échoué`);
}

async function fetchTags(ids, key) {
  const cached = new URL(`france-tags-${key}.json`, CACHE);
  if (existsSync(cached)) return JSON.parse(await readFile(cached, 'utf8'));
  const elements = await overpass(`[out:json][timeout:250];way(id:${ids.join(',')});out tags;`, `tags ${key}`);
  const map = {};
  for (const w of elements) {
    const t = w.tags ?? {};
    map[w.id] = { surface: surfaceOf(t), kind: kindOf(t), raw: t.surface ?? null };
  }
  await writeFile(cached, JSON.stringify(map));
  return map;
}

/**
 * Résume les ways d'un tronçon en une seule valeur.
 *
 * On retient le revêtement le moins favorable, pas le plus fréquent : la
 * promesse du site est qu'un itinéraire annoncé lisse ne contient pas de
 * gravier. Et on ne conclut que si la moitié au moins des ways sont
 * renseignés — sinon le tronçon reste honnêtement « inconnu ».
 */
function summarize(ways, tagMap) {
  const known = ways.map((w) => tagMap[w]).filter(Boolean);
  if (!known.length) return { surface: null, surfaceType: null, kind: null };

  const surfaces = known.map((k) => k.surface).filter(Boolean);
  const surface =
    surfaces.length >= ways.length / 2
      ? surfaces.reduce((worst, s) => (SURFACE_RANK[s] > SURFACE_RANK[worst] ? s : worst))
      : null;

  const kinds = known.map((k) => k.kind).filter(Boolean);
  let kind = null;
  if (kinds.length) {
    // « Voie verte » n'est retenu que si tout le tronçon en est une : un seul
    // passage sur route suffit à disqualifier la promesse « sans voiture ».
    kind = kinds.every((k) => k === 'Voie verte')
      ? 'Voie verte'
      : [...kinds].sort(
          (a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length,
        )[0];
  }

  const rawSurfaces = known.map((k) => k.raw).filter(Boolean);
  return { surface, surfaceType: rawSurfaces[0] ?? null, kind };
}

async function main() {
  if (!existsSync(ROUTES)) {
    console.error('data/raw/france-routes.geojson absent — lancez d’abord npm run fetch:france');
    process.exit(1);
  }
  await mkdir(CACHE, { recursive: true });

  const collection = JSON.parse(await readFile(ROUTES, 'utf8'));
  const features = collection.features.filter((f) => f.properties.src === 'osm');
  const withWays = features.filter((f) => Array.isArray(f.properties.ways));
  if (!withWays.length) {
    console.error(
      'Aucun identifiant de way dans le fichier : relancez npm run fetch:france ' +
        '(instantané, les lots sont en cache) pour régénérer le GeoJSON.',
    );
    process.exit(1);
  }

  const allWays = [...new Set(withWays.flatMap((f) => f.properties.ways))];
  console.log(`Enrichissement de ${withWays.length} tronçons français (${allWays.length} ways)`);

  const tagMap = {};
  const chunks = [];
  for (let i = 0; i < allWays.length; i += WAYS_PER_QUERY) {
    chunks.push(allWays.slice(i, i + WAYS_PER_QUERY));
  }
  for (const [i, chunk] of chunks.entries()) {
    Object.assign(tagMap, await fetchTags(chunk, String(i)));
    console.log(`  lot ${i + 1}/${chunks.length} — ${Object.keys(tagMap).length} ways connus`);
  }

  let filledSurface = 0;
  let green = 0;
  for (const f of withWays) {
    const { surface, surfaceType, kind } = summarize(f.properties.ways, tagMap);
    if (surface) {
      f.properties.surface = surface;
      f.properties.surfaceType = surfaceType;
      filledSurface++;
    }
    if (kind) {
      f.properties.kind = kind;
      if (kind === 'Voie verte') green++;
    }
  }

  await writeFile(ROUTES, JSON.stringify(collection));
  const km = (list) => Math.round(list.reduce((s, f) => s + f.properties.len, 0) / 1000);
  console.log(
    `  → revêtement renseigné sur ${filledSurface}/${withWays.length} tronçons ` +
      `(${Math.round((filledSurface / withWays.length) * 100)}%), ` +
      `${green} tronçons en voie verte (${km(withWays.filter((f) => f.properties.kind === 'Voie verte'))} km)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
