/**
 * Récupère les gares ferroviaires voyageurs de Belgique et de France.
 *
 * Une sortie à vélo commence rarement à un point GPS : elle commence à une gare.
 * C'est le pivot de V-lo — on rattache ensuite chaque gare au réseau cyclable.
 *
 * Sources :
 *  - Belgique : iRail (données SNCB/NMBS) — https://api.irail.be — CC0
 *  - France   : SNCF Open Data « liste-des-gares » — Licence Ouverte / ODbL
 *
 * Sortie : data/raw/stations.geojson
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fetchRetry } from './lib/util.mjs';

async function belgianStations() {
  const res = await fetchRetry('https://api.irail.be/v1/stations/?format=json&lang=fr', {
    headers: { Accept: 'application/json', 'User-Agent': 'V-lo/0.1' },
    redirect: 'follow',
  });
  const data = await res.json();
  return (data.station ?? [])
    .map((s) => ({
      id: `be-${s.id}`,
      name: s.standardname || s.name,
      country: 'BE',
      lon: Number(s.locationX),
      lat: Number(s.locationY),
    }))
    // iRail référence aussi des gares frontalières NL/FR/DE : on garde la Belgique.
    .filter((s) => s.lon > 2.5 && s.lon < 6.5 && s.lat > 49.4 && s.lat < 51.6);
}

async function frenchStations() {
  const out = [];
  const limit = 100;
  for (let offset = 0; offset < 7000; offset += limit) {
    const url =
      'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/liste-des-gares/records' +
      `?limit=${limit}&offset=${offset}&where=voyageurs%3D%22O%22&select=code_uic,libelle,commune,departemen,c_geo`;
    const res = await fetchRetry(url);
    const data = await res.json();
    const rows = data.results ?? [];
    for (const r of rows) {
      if (!r.c_geo) continue;
      out.push({
        id: `fr-${r.code_uic}`,
        name: r.libelle,
        commune: r.commune ?? null,
        dept: r.departemen ?? null,
        country: 'FR',
        lon: r.c_geo.lon,
        lat: r.c_geo.lat,
      });
    }
    if (rows.length < limit) break;
  }
  return out;
}

async function main() {
  console.log('Gares — iRail (BE) + SNCF Open Data (FR)');
  const [be, fr] = await Promise.all([belgianStations(), frenchStations()]);
  console.log(`  ${be.length} gares belges, ${fr.length} gares françaises`);

  const features = [...be, ...fr].map((s) => ({
    type: 'Feature',
    properties: { ...s, lon: undefined, lat: undefined },
    geometry: { type: 'Point', coordinates: [Number(s.lon.toFixed(5)), Number(s.lat.toFixed(5))] },
  }));

  await mkdir(new URL('../data/raw/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../data/raw/stations.geojson', import.meta.url),
    JSON.stringify({ type: 'FeatureCollection', features }),
  );
  console.log('  écrit data/raw/stations.geojson');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
