/**
 * Vérification du planificateur en dehors du navigateur.
 *
 * Sert à répondre à la seule question qui compte pour la crédibilité du site :
 * les distances annoncées correspondent-elles à un vrai chemin sur le réseau,
 * et les filtres laissent-ils encore un réseau utilisable ?
 *
 * Usage : node scripts/check-routing.mjs [nom de gare]
 */
import { readFile } from 'node:fs/promises';
import { buildAdjacency, dijkstra, pathEdges, describePath } from '../web/js/router.js';

const OUT = new URL('../web/data/', import.meta.url);
const read = async (f) => JSON.parse(await readFile(new URL(f, OUT), 'utf8'));

const KINDS_GREEN = new Set(['RAVeL', 'Voie verte', 'Autre site propre', 'Pré-RAVeL']);
const km = (m) => `${(m / 1000).toFixed(1)} km`;

const network = await read('network.geojson');
const graph = await read('graph.json');
const stations = await read('stations.json');
const segments = network.features.map((f) => f.properties);

const SCENARIOS = [
  { label: 'tout le réseau', openOnly: false, greenOnly: false, surface: 'any' },
  { label: 'ouvert seulement', openOnly: true, greenOnly: false, surface: 'any' },
  { label: 'ouvert + site propre', openOnly: true, greenOnly: true, surface: 'any' },
  { label: 'ouvert + site propre + lisse', openOnly: true, greenOnly: true, surface: 'smooth' },
];

const allow = (o) => (p) => {
  if (!p) return false;
  if (o.openOnly && p.s !== 'open') return false;
  if (o.greenOnly && !KINDS_GREEN.has(p.k)) return false;
  if (o.surface === 'smooth' && p.sf !== 'smooth') return false;
  if (o.surface === 'ridable' && p.sf !== 'smooth' && p.sf !== 'rough') return false;
  return true;
};

const wanted = process.argv[2] ?? 'Namur';
const start = stations.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
if (!start) {
  console.error(`Gare inconnue : ${wanted}`);
  process.exit(1);
}
console.log(`Départ : ${start.name} (réseau à ${start.access} m)\n`);

for (const scenario of SCENARIOS) {
  const { adj, kept } = buildAdjacency(graph, segments, allow(scenario));
  const result = dijkstra(adj, start.node, 60_000);

  const reachable = stations
    .filter((s) => s.id !== start.id && isFinite(result.dist[s.node]) && result.dist[s.node] >= 4000)
    .sort((a, b) => result.dist[b.node] - result.dist[a.node]);

  console.log(
    `${scenario.label.padEnd(30)} ${String(kept).padStart(5)}/${graph.edges.length} tronçons · ` +
      `${String(reachable.length).padStart(3)} gares à ≤60 km`,
  );

  const far = reachable[0];
  if (far) {
    const edges = pathEdges(result, far.node);
    const summary = describePath(edges, graph, segments);
    const straight = Math.round(
      6371e3 *
        Math.acos(
          Math.min(
            1,
            Math.sin((start.lat * Math.PI) / 180) * Math.sin((far.lat * Math.PI) / 180) +
              Math.cos((start.lat * Math.PI) / 180) *
                Math.cos((far.lat * Math.PI) / 180) *
                Math.cos(((far.lon - start.lon) * Math.PI) / 180),
          ),
        ),
    );
    console.log(
      `  la plus lointaine : ${far.name} — ${km(summary.total)} sur le réseau ` +
        `(${km(straight)} à vol d'oiseau, détour ×${(summary.total / straight).toFixed(2)})`,
    );
    console.log(
      `  ${Math.round((summary.smooth / summary.total) * 100)}% lisse, ` +
        `${Math.round((summary.green / summary.total) * 100)}% site propre, ` +
        `via ${summary.names.slice(0, 3).join(' / ') || '—'}`,
    );
    // Un itinéraire plus court que le vol d'oiseau signalerait un graphe faux.
    if (summary.total < straight * 0.98) {
      console.error('  !! itinéraire plus court que la distance à vol d’oiseau — graphe suspect');
      process.exitCode = 1;
    }
  }
  console.log();
}
