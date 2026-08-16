/**
 * Récupère les segments RAVeL / Véloroutes de Wallonie depuis le service
 * ArcGIS REST du Service public de Wallonie (Géoportail de la Wallonie).
 *
 * Source  : https://geoportail.wallonie.be/catalogue/f1ed4a9c-2d3f-4982-b3f8-42b4512d47f3.html
 * Licence : CC-BY 4.0 — © SPW (Service public de Wallonie)
 *
 * Sortie : data/raw/ravel-segments.geojson (schéma normalisé V-lo)
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fetchRetry, lineLength, simplify, roundCoords } from './lib/util.mjs';

const BASE =
  'https://geoservices.wallonie.be/arcgis/rest/services/MOBILITE/RAVEL_VELOROUTES/MapServer';
const LAYER_SEGMENTS = 5;
const PAGE = 1000;

// Le champ AVANCEMENT du SPW distingue ce qui est réellement roulable
// de ce qui n'est encore qu'un projet. C'est l'information que la plupart
// des cartes grand public écrasent — on la garde telle quelle.
const STATUS = {
  Ouvert: 'open',
  'Tracé arrêté': 'staked',
  Projet: 'planned',
  Potentiel: 'potential',
};

// REVETEMENT décrit le confort ressenti, REVETEMENT_TYPE la matière.
const SURFACE = {
  'Confortable et lisse': 'smooth',
  'Confortable non lisse (rugueux)': 'rough',
  'Inconfortable (meuble)': 'loose',
};

async function queryPage(offset) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: [
      'ID_SEGM',
      'NOM',
      'ACRONYME',
      'STATUT',
      'AVANCEMENT',
      'AN_OUVERT',
      'SENSUNIQUE',
      'REVETEMENT',
      'REVETEMENT_TYPE',
      'JALONNE',
      'LARGEUR',
      'ORIGIN_HIS',
      'GESTION',
    ].join(','),
    outSR: '4326',
    f: 'geojson',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    orderByFields: 'OBJECTID',
  });
  const res = await fetchRetry(`${BASE}/${LAYER_SEGMENTS}/query?${params}`);
  return res.json();
}

function normalize(feature, i) {
  const p = feature.properties ?? {};
  const geom = feature.geometry;
  if (!geom) return null;

  // Le service renvoie des LineString ou MultiLineString : on éclate en parties.
  const parts =
    geom.type === 'LineString'
      ? [geom.coordinates]
      : geom.type === 'MultiLineString'
        ? geom.coordinates
        : [];

  return parts
    .filter((c) => c.length >= 2)
    .map((coords, part) => {
      const simplified = roundCoords(simplify(coords, 4));
      return {
        type: 'Feature',
        properties: {
          id: `be-${p.ID_SEGM ?? i}-${part}`,
          src: 'ravel',
          country: 'BE',
          region: 'Wallonie',
          name: p.NOM || p.ACRONYME || null,
          ref: p.ACRONYME || null,
          // STATUT = nature de l'aménagement (RAVeL, voie verte, route partagée…)
          kind: p.STATUT || null,
          status: STATUS[p.AVANCEMENT] ?? null,
          statusLabel: p.AVANCEMENT || null,
          surface: SURFACE[p.REVETEMENT] ?? null,
          surfaceType: p.REVETEMENT_TYPE || null,
          signed: p.JALONNE === 'Vrai' ? true : p.JALONNE === 'Faux' ? false : null,
          oneway: p.SENSUNIQUE === 'Vrai',
          width: typeof p.LARGEUR === 'number' ? p.LARGEUR : null,
          origin: p.ORIGIN_HIS || null,
          openedYear: p.AN_OUVERT || null,
          len: Math.round(lineLength(coords)),
        },
        geometry: { type: 'LineString', coordinates: simplified },
      };
    });
}

async function main() {
  console.log('RAVeL — Service public de Wallonie (CC-BY 4.0)');

  const countRes = await fetchRetry(
    `${BASE}/${LAYER_SEGMENTS}/query?where=1%3D1&returnCountOnly=true&f=json`,
  );
  const { count } = await countRes.json();
  console.log(`  ${count} segments annoncés par le service`);

  const features = [];
  for (let offset = 0; offset < count; offset += PAGE) {
    const page = await queryPage(offset);
    const got = page.features ?? [];
    console.log(`  page ${offset}–${offset + got.length}`);
    got.forEach((f, i) => {
      const norm = normalize(f, offset + i);
      if (norm) features.push(...norm);
    });
    if (got.length === 0) break;
  }

  const total = features.reduce((s, f) => s + f.properties.len, 0);
  const open = features
    .filter((f) => f.properties.status === 'open')
    .reduce((s, f) => s + f.properties.len, 0);
  console.log(
    `  → ${features.length} tronçons, ${(total / 1000).toFixed(0)} km dont ${(open / 1000).toFixed(0)} km ouverts`,
  );

  await mkdir(new URL('../data/raw/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../data/raw/ravel-segments.geojson', import.meta.url),
    JSON.stringify({ type: 'FeatureCollection', features }),
  );
  console.log('  écrit data/raw/ravel-segments.geojson');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
