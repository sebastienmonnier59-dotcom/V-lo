import { buildAdjacency, dijkstra, pathEdges, describePath } from './router.js';
import { parseQuery, norm, EXAMPLES } from './nlq.js';

const KINDS_GREEN = new Set(['RAVeL', 'Voie verte', 'Autre site propre', 'Pré-RAVeL']);

const STATUS_COLORS = {
  open: '#2ee08a',
  staked: '#7fb3ff',
  planned: '#f0a132',
  potential: '#6a7684',
};
const SURFACE_COLORS = {
  smooth: '#2ee08a',
  rough: '#f0a132',
  loose: '#e2604a',
};

const state = {
  meta: null,
  segments: [], // propriétés indexées par position dans network.geojson
  features: [],
  graph: null,
  stations: [],
  routes: [],
  station: null,
  maxKm: 40,
  mode: 'oneway',
  surface: 'any',
  greenOnly: false,
  openOnly: true,
  colorMode: 'status',
  reachable: [],
  blockers: [],
  selected: null,
  lastRun: null,
};

const $ = (id) => document.getElementById(id);

/**
 * Les couches sont ajoutées après le chargement du style, et un fond de carte
 * peut échouer (réseau coupé, tuiles indisponibles). Le planificateur, lui, ne
 * dépend que des données déjà en mémoire : il doit continuer à répondre.
 */
let mapReady = false;
function withMap(fn) {
  if (!mapReady || !map) return;
  try {
    fn();
  } catch (err) {
    console.warn('carte indisponible :', err.message);
  }
}
const km = (m) => `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);

/* ------------------------------------------------------------------ carte */

const BASEMAPS = {
  sobre: {
    tiles: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    ],
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
  },
  cyclo: {
    tiles: [
      'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    ],
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · rendu <a href="https://www.cyclosm.org/">CyclOSM</a>',
  },
};

let map;

function styleFor(key) {
  const bm = BASEMAPS[key];
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: bm.tiles, tileSize: 256, attribution: bm.attribution },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

function lineColorExpression() {
  if (state.colorMode === 'surface') {
    return [
      'match',
      ['get', 'sf'],
      'smooth', SURFACE_COLORS.smooth,
      'rough', SURFACE_COLORS.rough,
      'loose', SURFACE_COLORS.loose,
      '#8fa0b4',
    ];
  }
  return [
    'match',
    ['get', 's'],
    'open', STATUS_COLORS.open,
    'staked', STATUS_COLORS.staked,
    'planned', STATUS_COLORS.planned,
    'potential', STATUS_COLORS.potential,
    '#8fa0b4',
  ];
}

function addNetworkLayers() {
  map.addSource('network', { type: 'geojson', data: { type: 'FeatureCollection', features: state.features } });
  map.addSource('path', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('stations', { type: 'geojson', data: stationsGeoJSON() });

  map.addLayer({
    id: 'network-casing',
    type: 'line',
    source: 'network',
    paint: {
      'line-color': '#0e1319',
      'line-opacity': 0.45,
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2.2, 12, 6, 16, 10],
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  map.addLayer({
    id: 'network',
    type: 'line',
    source: 'network',
    paint: {
      'line-color': lineColorExpression(),
      // Ce qui n'est pas ouvert se voit, mais ne se confond jamais avec le roulable.
      'line-opacity': ['case', ['==', ['get', 's'], 'open'], 0.95, 0.55],
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.1, 12, 3.2, 16, 6],
      'line-dasharray': ['case', ['==', ['get', 's'], 'open'], ['literal', [1, 0]], ['literal', [2, 1.6]]],
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  map.addLayer({
    id: 'path',
    type: 'line',
    source: 'path',
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, 3.5, 12, 7, 16, 11],
      'line-opacity': 0.9,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.moveLayer('path', 'network');

  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 12, 5, 16, 7],
      'circle-color': ['case', ['get', 'isStart'], '#ffffff', '#151c25'],
      'circle-stroke-color': ['case', ['get', 'isStart'], '#2ee08a', '#8fa0b4'],
      'circle-stroke-width': ['case', ['get', 'isStart'], 3, 1.4],
    },
  });

  map.on('click', 'network', (e) => showSegmentPopup(e));
  map.on('click', 'stations', (e) => {
    const name = e.features[0].properties.name;
    const found = state.stations.find((s) => s.name === name);
    if (found) selectStation(found);
  });
  for (const layer of ['network', 'stations']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }
}

function stationsGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: state.stations.map((s) => ({
      type: 'Feature',
      properties: { name: s.name, isStart: state.station?.id === s.id },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  };
}

const SURFACE_LABEL = { smooth: 'Confortable et lisse', rough: 'Confortable mais rugueux', loose: 'Meuble, inconfortable' };
const STATUS_LABEL = { open: 'Ouvert', staked: 'Tracé arrêté', planned: 'En projet', potential: 'Potentiel' };

function showSegmentPopup(e) {
  const p = e.features[0].properties;
  const rows = [
    ['État', STATUS_LABEL[p.s] ?? '—'],
    ['Type', p.k ?? '—'],
    ['Revêtement', p.st || SURFACE_LABEL[p.sf] || 'non renseigné'],
    ['Longueur', km(Number(p.l))],
  ];
  if (p.w) rows.push(['Largeur', `${p.w} m`]);
  if (p.sg === 'true' || p.sg === true) rows.push(['Balisage', 'jalonné']);

  new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
    .setLngLat(e.lngLat)
    .setHTML(
      `<h4>${escapeHtml(p.n || p.r || 'Tronçon')}</h4><dl>${rows
        .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
        .join('')}</dl>`,
    )
    .addTo(map);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* -------------------------------------------------------------- calculs */

function allowSegment(p) {
  if (!p) return false;
  if (state.openOnly && p.s !== 'open') return false;
  if (state.greenOnly && !KINDS_GREEN.has(p.k)) return false;
  if (state.surface === 'smooth' && p.sf !== 'smooth') return false;
  if (state.surface === 'ridable' && p.sf !== 'smooth' && p.sf !== 'rough') return false;
  return true;
}

/**
 * Dit quelle contrainte écarte un tronçon donné — dans l'ordre où elles
 * s'appliquent, pour pouvoir nommer le verrou plutôt que de rendre une liste vide.
 */
function rejectReason(p) {
  if (!p) return null;
  if (state.openOnly && p.s !== 'open') {
    return { rule: 'openOnly', label: `marqué « ${(STATUS_LABEL[p.s] ?? 'non ouvert').toLowerCase()} »` };
  }
  if (state.greenOnly && !KINDS_GREEN.has(p.k)) {
    return { rule: 'greenOnly', label: `${(p.k ?? 'voie').toLowerCase()}, hors site propre` };
  }
  if (state.surface === 'smooth' && p.sf !== 'smooth') {
    return {
      rule: 'surface',
      label: p.sf ? (SURFACE_LABEL[p.sf] ?? 'revêtement écarté').toLowerCase() : 'revêtement non renseigné',
    };
  }
  if (state.surface === 'ridable' && p.sf !== 'smooth' && p.sf !== 'rough') {
    return {
      rule: 'surface',
      label: p.sf ? (SURFACE_LABEL[p.sf] ?? 'revêtement écarté').toLowerCase() : 'revêtement non renseigné',
    };
  }
  return null;
}

const RULE_ACTION = {
  openOnly: 'Inclure les tronçons non ouverts',
  greenOnly: 'Accepter hors site propre',
  surface: 'Accepter tous les revêtements',
};

/**
 * Cherche les tronçons qui se trouvent exactement à la frontière du réseau
 * atteignable : ce sont eux, et eux seuls, qui limitent la sortie.
 */
function findBlockers(dist) {
  const blockers = new Map();
  state.graph.edges.forEach(([a, b, len, seg]) => {
    if (isFinite(dist[a]) === isFinite(dist[b])) return;
    const p = state.segments[seg];
    const reason = rejectReason(p);
    if (!reason) return;
    const current = blockers.get(reason.rule);
    if (!current || len < current.len) {
      blockers.set(reason.rule, { ...reason, len, name: p.n ?? p.r ?? 'tronçon' });
    }
  });
  return [...blockers.values()].sort((a, b) => a.len - b.len);
}

function run() {
  if (!state.station) {
    state.reachable = [];
    state.selected = null;
    renderResults();
    return;
  }
  const budget = state.mode === 'roundtrip' ? (state.maxKm * 1000) / 2 : state.maxKm * 1000;
  const { adj, kept } = buildAdjacency(state.graph, state.segments, allowSegment);
  const result = dijkstra(adj, state.station.node, budget);

  const byName = new Map();
  for (const s of state.stations) {
    const d = result.dist[s.node];
    if (!isFinite(d) || s.id === state.station.id) continue;
    // Sous 4 km, ce n'est pas une sortie : c'est la gare d'à côté.
    if (d < 4000) continue;
    const previous = byName.get(s.name);
    if (previous && previous.dist >= d) continue;
    byName.set(s.name, { station: s, dist: d });
  }

  state.reachable = [...byName.values()].sort((a, b) => b.dist - a.dist).slice(0, 30);
  state.blockers = findBlockers(result.dist);
  state.lastRun = { result, kept, budget };
  state.selected = null;
  setPath([]);
  renderResults();
}

/** Remet les géométries bout à bout dans le sens de la marche. */
function pathCoordinates(edgeIndices) {
  let node = state.station.node;
  const out = [];
  for (const edgeIndex of edgeIndices) {
    const [a, b, , seg] = state.graph.edges[edgeIndex];
    const forward = a === node;
    const coords = forward
      ? state.features[seg].geometry.coordinates
      : state.features[seg].geometry.coordinates.slice().reverse();
    node = forward ? b : a;
    out.push(...(out.length ? coords.slice(1) : coords));
  }
  return out;
}

function setPath(coords) {
  withMap(() =>
    map.getSource('path').setData({
      type: 'FeatureCollection',
      features: coords.length
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }]
        : [],
    }),
  );
}

function selectDestination(entry) {
  const edges = pathEdges(state.lastRun.result, entry.station.node);
  const coords = pathCoordinates(edges);
  const summary = describePath(edges, state.graph, state.segments);
  state.selected = { entry, edges, coords, summary };
  setPath(coords);

  withMap(() => {
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 60, duration: 700 },
    );
  });
  renderResults();
}

/* ------------------------------------------------------------------ GPX */

function buildGpx() {
  const { entry, coords, summary } = state.selected;
  const outbound = coords;
  const full = state.mode === 'roundtrip' ? [...outbound, ...outbound.slice(0, -1).reverse()] : outbound;
  const name = `V-lo ${state.station.name} → ${entry.station.name}`;
  const points = full.map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"/>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="V-lo" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeHtml(name)}</name>
    <desc>${km(state.mode === 'roundtrip' ? summary.total * 2 : summary.total)} — ${pct(summary.green, summary.total)}% en site propre. Données : SPW (CC-BY 4.0) et OpenStreetMap (ODbL).</desc>
  </metadata>
  <trk>
    <name>${escapeHtml(name)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

function downloadGpx() {
  const blob = new Blob([buildGpx()], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `v-lo-${norm(state.station.name).replace(/ /g, '-')}-${norm(state.selected.entry.station.name).replace(/ /g, '-')}.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------------------------------------------------------- rendu */

function renderResults() {
  const box = $('results');
  if (!state.station) {
    box.innerHTML = '<p class="empty">Choisissez une gare de départ, ou décrivez votre sortie en une phrase ci-dessus.</p>';
    return;
  }
  if (!state.reachable.length) {
    box.innerHTML = `<p class="empty">Aucune gare atteignable depuis ${escapeHtml(state.station.name)} avec ces critères.</p>${blockersHtml()}`;
    wireBlockers();
    return;
  }

  const head = state.mode === 'roundtrip'
    ? `${state.reachable.length} points de demi-tour à ${state.maxKm} km aller-retour maximum`
    : `${state.reachable.length} gares atteignables en ${state.maxKm} km maximum`;

  const items = state.reachable
    .map((entry, i) => {
      const shown = state.mode === 'roundtrip' ? entry.dist * 2 : entry.dist;
      const on = state.selected?.entry === entry ? ' on' : '';
      const access = entry.station.access > 400 ? ` · ${entry.station.access} m depuis la gare` : '';
      return `<button class="result${on}" data-i="${i}">
        <span class="name">${escapeHtml(entry.station.name)}</span>
        <span class="km">${km(shown)}</span>
        <span class="sub">${escapeHtml(entry.station.commune ?? entry.station.country === 'BE' ? 'Belgique' : entry.station.commune ?? '')}${access}</span>
      </button>`;
    })
    .join('');

  box.innerHTML = `<p class="results-head">${head}</p>${blockersHtml()}${items}<div id="detail-slot"></div>`;
  wireBlockers();

  box.querySelectorAll('.result').forEach((el) =>
    el.addEventListener('click', () => selectDestination(state.reachable[Number(el.dataset.i)])),
  );

  if (state.selected) renderDetail();
}

/**
 * Le point le plus utile du site : quand le réseau s'arrête, dire pourquoi.
 * Un RAVeL peut être coupé par 90 mètres non aménagés — aucune carte ne le dit,
 * et c'est pourtant ce qui décide si la sortie est possible ou non.
 */
function blockersHtml() {
  // Un verrou de plusieurs kilomètres n'apprend rien : c'est le réseau qui s'arrête.
  const notable = state.blockers.filter((b) => b.len <= 1500).slice(0, 2);
  if (!notable.length) return '';
  return notable
    .map(
      (b) => `<div class="blocker">
        <p><b>${km(b.len)}</b> bloquent la suite du réseau : ${escapeHtml(b.name)}, ${escapeHtml(b.label)}.</p>
        <button class="btn ghost" data-rule="${b.rule}">${RULE_ACTION[b.rule]}</button>
      </div>`,
    )
    .join('');
}

function wireBlockers() {
  document.querySelectorAll('.blocker button').forEach((el) =>
    el.addEventListener('click', () => {
      const rule = el.dataset.rule;
      if (rule === 'openOnly') {
        state.openOnly = false;
        $('open-only').checked = false;
      } else if (rule === 'greenOnly') {
        state.greenOnly = false;
        $('green-only').checked = false;
      } else {
        state.surface = 'any';
        $('surface')
          .querySelectorAll('button')
          .forEach((b) => b.classList.toggle('on', b.dataset.value === 'any'));
      }
      run();
    }),
  );
}

function renderDetail() {
  const { entry, summary } = state.selected;
  const total = state.mode === 'roundtrip' ? summary.total * 2 : summary.total;
  const green = pct(summary.green, summary.total);
  const smooth = pct(summary.smooth, summary.total);
  const unknown = pct(summary.unknownSurface, summary.total);
  const hours = total / 1000 / 15;

  const bar = [
    ['#2ee08a', summary.smooth, 'lisse'],
    ['#f0a132', summary.total - summary.smooth - summary.unknownSurface, 'rugueux ou meuble'],
    ['#4a5666', summary.unknownSurface, 'non renseigné'],
  ].filter(([, v]) => v > 0);

  $('detail-slot').innerHTML = `
    <div id="detail">
      <h3>${escapeHtml(state.station.name)} → ${escapeHtml(entry.station.name)}</h3>
      <div class="stats">
        <div class="stat"><b>${km(total)}</b><span>sur le réseau</span></div>
        <div class="stat"><b>${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`}</b><span>à 15 km/h</span></div>
        <div class="stat"><b>${green}%</b><span>en site propre</span></div>
      </div>
      <div class="bar">${bar.map(([c, v]) => `<i style="background:${c};width:${pct(v, summary.total)}%"></i>`).join('')}</div>
      <div class="bar-legend">
        <span><b>${smooth}%</b> lisse</span>
        ${unknown ? `<span><b>${unknown}%</b> revêtement non renseigné</span>` : ''}
        ${summary.names.length ? `<span>via ${escapeHtml(summary.names.slice(0, 3).join(', '))}</span>` : ''}
      </div>
      <div class="actions">
        <button class="btn" id="gpx">Télécharger le GPX</button>
        <button class="btn ghost" id="clear-path">Effacer</button>
      </div>
    </div>`;

  $('gpx').addEventListener('click', downloadGpx);
  $('clear-path').addEventListener('click', () => {
    state.selected = null;
    setPath([]);
    renderResults();
  });
}

function renderLegend() {
  const rows =
    state.colorMode === 'surface'
      ? [
          [SURFACE_COLORS.smooth, 'Confortable et lisse (asphalte, béton)'],
          [SURFACE_COLORS.rough, 'Confortable mais rugueux (empierrement, pavés)'],
          [SURFACE_COLORS.loose, 'Meuble : terre, sable, gravier'],
          ['#8fa0b4', 'Revêtement non renseigné'],
        ]
      : [
          [STATUS_COLORS.open, 'Ouvert — praticable aujourd’hui'],
          [STATUS_COLORS.staked, 'Tracé arrêté — pas encore aménagé'],
          [STATUS_COLORS.planned, 'En projet'],
          [STATUS_COLORS.potential, 'Potentiel, à l’étude'],
        ];
  $('legend').innerHTML = rows
    .map(([c, label]) => `<div class="legend-row"><i class="swatch" style="background:${c}"></i>${label}</div>`)
    .join('');
}

function renderRoutes(filter = '') {
  const q = norm(filter);
  const list = state.routes
    .filter((r) => !q || norm(`${r.ref ?? ''} ${r.name ?? ''}`).includes(q))
    .slice(0, 120);
  $('route-list').innerHTML = list.length
    ? list
        .map(
          (r, i) => `<button class="route" data-i="${state.routes.indexOf(r)}">
            <span class="r-name">${escapeHtml(r.ref ? `${r.ref} · ${r.name ?? ''}` : (r.name ?? ''))}</span>
            <span class="r-km">${Math.round(r.len / 1000)} km${r.openLen < r.len ? ` · ${pct(r.openLen, r.len)}% ouvert` : ''}</span>
          </button>`,
        )
        .join('')
    : '<p class="empty">Aucun itinéraire ne correspond.</p>';

  $('route-list')
    .querySelectorAll('.route')
    .forEach((el) =>
      el.addEventListener('click', () => {
        const r = state.routes[Number(el.dataset.i)];
        withMap(() =>
          map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 50, duration: 800 }),
        );
      }),
    );
}

function renderAbout() {
  const m = state.meta;
  $('about-body').innerHTML = `
    <div class="kpi">
      <div class="stat"><b>${m.totalKm.toLocaleString('fr')} km</b><span>de réseau cartographié</span></div>
      <div class="stat"><b>${m.openKm.toLocaleString('fr')} km</b><span>réellement ouverts</span></div>
      <div class="stat"><b>${m.stations}</b><span>gares connectées</span></div>
      <div class="stat"><b>${m.routes}</b><span>itinéraires nommés</span></div>
    </div>
    <h3>D'où viennent les données</h3>
    <ul>
      <li><b>RAVeL &amp; véloroutes de Wallonie</b> — Service public de Wallonie, via le
        <a href="https://geoportail.wallonie.be/catalogue/f1ed4a9c-2d3f-4982-b3f8-42b4512d47f3.html" target="_blank" rel="noopener">Géoportail</a>. Licence CC-BY 4.0.
        C'est la source qui renseigne le revêtement, la largeur, le jalonnement et surtout l'état d'avancement réel de chaque tronçon.</li>
      <li><b>Véloroutes nationales et EuroVelo en France</b> — <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a>, licence ODbL.
        Le jeu ON3V publié sur data.gouv.fr n'ayant plus été mis à jour depuis 2017, OSM est aujourd'hui la source la plus fraîche.</li>
      <li><b>Gares</b> — <a href="https://api.irail.be" target="_blank" rel="noopener">iRail</a> pour la Belgique,
        <a href="https://ressources.data.sncf.com" target="_blank" rel="noopener">SNCF Open Data</a> pour la France.</li>
    </ul>
    <h3>Ce que le site fait, et ne fait pas</h3>
    <p>Les distances affichées sont mesurées <b>sur le réseau cyclable lui-même</b>, pas à vol d'oiseau
    ni sur le réseau routier. Un itinéraire proposé n'emprunte que des tronçons qui satisfont vos filtres :
    si vous demandez du lisse, aucun mètre de gravier ne s'y glissera.</p>
    <p>En revanche le calcul s'arrête au bord du réseau : le raccordement entre la gare et le premier
    tronçon (indiqué en mètres) reste à votre charge, et le relief n'est pas encore pris en compte.</p>
    <h3>Limite connue sur la France</h3>
    <p>Le revêtement est renseigné pour la quasi-totalité des tronçons wallons, mais rarement au niveau
    des relations OpenStreetMap françaises. Les filtres de revêtement sont donc beaucoup plus sélectifs
    en France qu'en Wallonie — ce que la barre « revêtement non renseigné » de chaque itinéraire indique.</p>
    <p class="hint">Données assemblées le ${m.builtAt}. Graphe : ${m.graph.nodes.toLocaleString('fr')} nœuds, ${m.graph.edges.toLocaleString('fr')} arêtes.</p>`;
}

/* -------------------------------------------------------------- contrôles */

function selectStation(station) {
  state.station = station;
  $('station').value = station.name;
  $('station-hint').textContent =
    station.access > 100
      ? `Réseau cyclable à ${station.access} m de la gare.`
      : 'Le réseau passe devant la gare.';
  withMap(() => {
    map.getSource('stations').setData(stationsGeoJSON());
    map.flyTo({ center: [station.lon, station.lat], zoom: Math.max(map.getZoom(), 10), duration: 800 });
  });
  run();
}

function wireSegmented(id, onChange) {
  $(id).addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    $(id)
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('on', b === button));
    onChange(button.dataset.value);
  });
}

function applyParsed(parsed) {
  // Tous les paramètres sont posés avant le moindre calcul : sélectionner la
  // gare d'abord relancerait le trajet avec la distance et les filtres précédents.
  if (parsed.maxKm) {
    state.maxKm = Math.min(150, Math.max(5, Math.round(parsed.maxKm / 5) * 5));
    $('maxkm').value = state.maxKm;
    $('maxkm-out').textContent = `${state.maxKm} km`;
  }
  state.surface = parsed.surface;
  state.greenOnly = parsed.greenOnly;
  state.openOnly = parsed.openOnly;
  state.mode = parsed.mode;

  $('green-only').checked = parsed.greenOnly;
  $('open-only').checked = parsed.openOnly;
  for (const [id, value] of [['surface', parsed.surface], ['mode', parsed.mode]]) {
    $(id)
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('on', b.dataset.value === value));
  }

  const box = $('nlq-understood');
  box.innerHTML = parsed.explain.map((e) => `<span class="chip">${escapeHtml(e.label)}</span>`).join('');
  box.hidden = parsed.explain.length === 0;

  if (parsed.station) selectStation(parsed.station);
  else run();
}

function wireControls() {
  $('nlq-examples').innerHTML = EXAMPLES.map(
    (e) => `<button class="example">${escapeHtml(e)}</button>`,
  ).join('');
  $('nlq-examples').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    $('nlq').value = button.textContent;
    applyParsed(parseQuery(button.textContent, state.stations));
  });

  let debounce;
  $('nlq').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => applyParsed(parseQuery(e.target.value, state.stations)), 320);
  });

  const stationInput = $('station');
  stationInput.addEventListener('input', () => {
    const q = norm(stationInput.value);
    const matches = state.stations.filter((s) => norm(s.name).includes(q)).slice(0, 20);
    $('station-list').innerHTML = matches.map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
    const exact = state.stations.find((s) => norm(s.name) === q);
    if (exact) selectStation(exact);
  });

  $('maxkm').addEventListener('input', (e) => {
    state.maxKm = Number(e.target.value);
    $('maxkm-out').textContent = `${state.maxKm} km`;
  });
  $('maxkm').addEventListener('change', run);

  wireSegmented('mode', (v) => {
    state.mode = v;
    $('mode-hint').textContent =
      v === 'roundtrip'
        ? 'Même gare au départ et à l’arrivée : la distance affichée compte l’aller et le retour.'
        : 'Retour en train depuis une autre gare.';
    run();
  });
  wireSegmented('surface', (v) => {
    state.surface = v;
    run();
  });
  wireSegmented('colormode', (v) => {
    state.colorMode = v;
    withMap(() => map.setPaintProperty('network', 'line-color', lineColorExpression()));
    renderLegend();
  });
  wireSegmented('basemap-switch', (v) => {
    withMap(() => {
      const center = map.getCenter();
      const zoom = map.getZoom();
      mapReady = false;
      map.setStyle(styleFor(v));
      map.once('styledata', () => {
        addNetworkLayers();
        mapReady = true;
        map.jumpTo({ center, zoom });
        if (state.selected) setPath(state.selected.coords);
      });
    });
  });

  $('green-only').addEventListener('change', (e) => {
    state.greenOnly = e.target.checked;
    run();
  });
  $('open-only').addEventListener('change', (e) => {
    state.openOnly = e.target.checked;
    run();
  });

  $('route-filter').addEventListener('input', (e) => renderRoutes(e.target.value));

  $('tabs').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    for (const b of $('tabs').querySelectorAll('button')) {
      const on = b === button;
      b.setAttribute('aria-selected', String(on));
      $(`tab-${b.dataset.tab}`).hidden = !on;
    }
  });
}

/* ----------------------------------------------------------------- boot */

async function boot() {
  const [meta, network, graph, stations, routes] = await Promise.all(
    ['meta.json', 'network.geojson', 'graph.json', 'stations.json', 'routes.json'].map((f) =>
      fetch(`data/${f}`).then((r) => {
        if (!r.ok) throw new Error(`data/${f} introuvable — lancez « npm run build »`);
        return r.json();
      }),
    ),
  );

  state.meta = meta;
  state.features = network.features;
  state.segments = network.features.map((f) => f.properties);
  state.graph = graph;
  state.stations = stations;
  state.routes = routes;

  $('tagline').textContent = `${meta.openKm.toLocaleString('fr')} km ouverts · ${meta.stations} gares connectées`;

  map = new maplibregl.Map({
    container: 'map',
    style: styleFor('sobre'),
    center: [4.6, 50.3],
    zoom: 7.2,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  map.on('load', () => {
    addNetworkLayers();
    mapReady = true;
    $('loading').hidden = true;
    if (state.station) withMap(() => map.getSource('stations').setData(stationsGeoJSON()));
    if (state.selected) setPath(state.selected.coords);
  });
  // Un fond de carte injoignable ne doit pas masquer le panneau de planification.
  map.on('error', () => {
    $('loading').hidden = true;
  });

  wireControls();
  renderLegend();
  renderRoutes();
  renderAbout();
  renderResults();
}

boot().catch((err) => {
  $('loading').textContent = err.message;
  console.error(err);
});
