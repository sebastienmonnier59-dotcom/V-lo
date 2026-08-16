/**
 * Analyse d'effet de levier : quels mètres manquants débloquent le plus de réseau ?
 *
 * Le site répond à un cycliste (« ce tronçon vous bloque »). Le même graphe
 * répond à un gestionnaire de voirie, qui pose la question inverse : sur quels
 * chantiers mettre l'argent en premier ?
 *
 * Méthode. On ne garde que les tronçons ouverts, ce qui casse le réseau en
 * composantes isolées. On repart de la plus grande et on l'étend de proche en
 * proche : à chaque tour, on cherche parmi les tronçons non ouverts celui qui
 * raccroche une composante au meilleur rapport « réseau rendu accessible /
 * longueur à aménager ». C'est une expansion gloutonne — pas un optimum global,
 * mais l'ordre de priorité qu'elle produit est celui qu'on veut lire.
 *
 * Usage : node scripts/gap-analysis.mjs [pays]   (BE par défaut)
 */
import { readFile } from 'node:fs/promises';

const OUT = new URL('../web/data/', import.meta.url);
const read = async (f) => JSON.parse(await readFile(new URL(f, OUT), 'utf8'));

const country = (process.argv[2] ?? 'BE').toUpperCase();
const network = await read('network.geojson');
const graph = await read('graph.json');
const stations = await read('stations.json');
const segments = network.features.map((f) => f.properties);

const inScope = (seg) => segments[seg]?.c === country;
const openEdges = [];
const gapEdges = [];
graph.edges.forEach((e, i) => {
  if (!inScope(e[3])) return;
  (segments[e[3]].s === 'open' ? openEdges : gapEdges).push([e, i]);
});

/** Composantes connexes du réseau réellement ouvert. */
const parent = new Int32Array(graph.nodes.length).fill(-1);
const find = (x) => {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
};
const union = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[ra] = rb;
  return ra !== rb;
};

for (const [e] of openEdges) {
  for (const n of [e[0], e[1]]) if (parent[n] === -1) parent[n] = n;
}
for (const [e] of gapEdges) {
  for (const n of [e[0], e[1]]) if (parent[n] === -1) parent[n] = n;
}
for (const [e] of openEdges) union(e[0], e[1]);

// Poids d'une composante : kilomètres ouverts et gares desservies.
const kmOf = new Map();
for (const [e] of openEdges) {
  const root = find(e[0]);
  kmOf.set(root, (kmOf.get(root) ?? 0) + e[2]);
}
const stationsOf = new Map();
for (const s of stations) {
  if (s.country !== country || parent[s.node] === -1) continue;
  const root = find(s.node);
  if (!stationsOf.has(root)) stationsOf.set(root, []);
  stationsOf.get(root).push(s.name);
}

const roots = [...new Set([...kmOf.keys()])];
const main = roots.sort((a, b) => (kmOf.get(b) ?? 0) - (kmOf.get(a) ?? 0))[0];

console.log(`Pays : ${country}`);
console.log(
  `Réseau ouvert : ${Math.round([...kmOf.values()].reduce((s, v) => s + v, 0) / 1000)} km ` +
    `en ${roots.length} morceaux isolés`,
);
console.log(
  `Le plus gros morceau en rassemble ${Math.round((kmOf.get(main) ?? 0) / 1000)} km ` +
    `et ${(stationsOf.get(main) ?? []).length} gares\n`,
);

// Expansion gloutonne depuis le morceau principal.
const used = new Set();
const merges = [];
for (let round = 0; round < 40; round++) {
  let best = null;
  for (const [e, i] of gapEdges) {
    if (used.has(i)) continue;
    const ra = find(e[0]);
    const rb = find(e[1]);
    if (ra === rb) continue;
    const mainRoot = find(main);
    if (ra !== mainRoot && rb !== mainRoot) continue;
    const other = ra === mainRoot ? rb : ra;
    const gainKm = (kmOf.get(other) ?? 0) / 1000;
    const gainStations = (stationsOf.get(other) ?? []).length;
    const cost = Math.max(e[2], 1) / 1000;
    // On classe sur le réseau débloqué par kilomètre aménagé.
    const score = (gainKm + gainStations * 2) / cost;
    if (!best || score > best.score) {
      best = {
        score, edge: e, index: i, other, gainKm, gainStations, cost,
        seg: segments[e[3]],
        // Relevé au moment du choix : la fusion vide ensuite `stationsOf`.
        names: (stationsOf.get(other) ?? []).slice(0, 3),
      };
    }
  }
  if (!best || best.gainKm + best.gainStations === 0) break;

  used.add(best.index);
  const mainRoot = find(main);
  kmOf.set(mainRoot, (kmOf.get(mainRoot) ?? 0) + (kmOf.get(best.other) ?? 0) + best.edge[2]);
  stationsOf.set(mainRoot, [...(stationsOf.get(mainRoot) ?? []), ...(stationsOf.get(best.other) ?? [])]);
  union(best.edge[0], best.edge[1]);
  merges.push(best);
}

console.log('Chantiers par effet de levier décroissant :\n');
let spent = 0;
let wonKm = 0;
let wonStations = 0;
for (const [i, m] of merges.slice(0, 15).entries()) {
  spent += m.cost;
  wonKm += m.gainKm;
  wonStations += m.gainStations;
  console.log(
    `${String(i + 1).padStart(2)}. ${(m.cost * 1000).toFixed(0).padStart(5)} m à aménager ` +
      `→ ${m.gainKm.toFixed(1).padStart(6)} km de réseau, ${String(m.gainStations).padStart(2)} gare(s)`,
  );
  console.log(
    `    ${m.seg.n ?? m.seg.r ?? 'tronçon'} — ${m.seg.s === 'staked' ? 'tracé arrêté' : m.seg.s === 'planned' ? 'en projet' : 'potentiel'}` +
      (m.names.length ? ` · débloque ${m.names.join(', ')}` : ''),
  );
}

console.log(
  `\nCumul des 15 premiers : ${(spent * 1000).toFixed(0)} m de travaux ` +
    `raccrochent ${wonKm.toFixed(0)} km de réseau et ${wonStations} gares.`,
);
console.log(
  `Soit ${(wonKm / Math.max(spent, 0.001)).toFixed(0)} km de réseau rendus accessibles ` +
    `par kilomètre aménagé.`,
);
