/**
 * Calcul d'itinéraires sur le réseau cyclable, dans le navigateur.
 *
 * Le graphe est petit (quelques dizaines de milliers d'arêtes) : un Dijkstra
 * complet depuis une gare prend quelques millisecondes. On peut donc recalculer
 * à chaque changement de filtre plutôt que de pré-calculer des réponses figées —
 * c'est ce qui permet de poser des questions du genre « et si j'exige du lisse ? »
 * et d'avoir la réponse immédiatement.
 */

/** File de priorité binaire minimale, suffisante et sans dépendance. */
class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  push(key, val) {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop() {
    const topKey = this.keys[0];
    const topVal = this.vals[0];
    const lastKey = this.keys.pop();
    const lastVal = this.vals.pop();
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.keys.length && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < this.keys.length && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return [topKey, topVal];
  }
  swap(i, j) {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.vals[i], this.vals[j]] = [this.vals[j], this.vals[i]];
  }
}

/**
 * Construit les listes d'adjacence en ne retenant que les arêtes acceptées.
 * `allow(segmentProperties)` décide tronçon par tronçon.
 */
export function buildAdjacency(graph, segments, allow) {
  const adj = Array.from({ length: graph.nodes.length }, () => []);
  let kept = 0;
  graph.edges.forEach(([a, b, len, seg], edgeIndex) => {
    const props = segments[seg];
    if (props && !allow(props)) return;
    kept++;
    adj[a].push([b, len, edgeIndex]);
    adj[b].push([a, len, edgeIndex]);
  });
  return { adj, kept };
}

/**
 * Dijkstra depuis un nœud, borné par `maxDist` (mètres).
 * Retourne les distances et de quoi reconstruire chaque chemin.
 */
export function dijkstra(adj, start, maxDist = Infinity) {
  const n = adj.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);

  dist[start] = 0;
  const heap = new MinHeap();
  heap.push(0, start);

  while (heap.size) {
    const [d, node] = heap.pop();
    if (settled[node]) continue;
    settled[node] = 1;
    if (d > maxDist) break;

    for (const [next, len, edgeIndex] of adj[node]) {
      const nd = d + len;
      if (nd > maxDist || nd >= dist[next]) continue;
      dist[next] = nd;
      prevNode[next] = node;
      prevEdge[next] = edgeIndex;
      heap.push(nd, next);
    }
  }
  return { dist, prevNode, prevEdge };
}

/** Remonte le chemin jusqu'au départ et renvoie les index d'arêtes traversées. */
export function pathEdges({ prevNode, prevEdge }, target) {
  const edges = [];
  let node = target;
  let guard = 0;
  while (prevEdge[node] !== -1 && guard++ < 100000) {
    edges.push(prevEdge[node]);
    node = prevNode[node];
  }
  return edges.reverse();
}

/**
 * Décrit un itinéraire : longueur, part de revêtement lisse, part en site propre.
 * C'est cette synthèse qui dit si la sortie sera agréable, pas la seule distance.
 */
export function describePath(edgeIndices, graph, segments) {
  let total = 0;
  let smooth = 0;
  let green = 0;
  let unknownSurface = 0;
  const names = [];
  const surfaces = new Map();

  for (const edgeIndex of edgeIndices) {
    const [, , len, seg] = graph.edges[edgeIndex];
    const p = segments[seg];
    total += len;
    if (!p) continue;
    if (p.sf === 'smooth') smooth += len;
    if (p.sf === null || p.sf === undefined) unknownSurface += len;
    if (p.k === 'RAVeL' || p.k === 'Voie verte' || p.k === 'Autre site propre') green += len;
    const label = (p.r || p.n || '').trim();
    if (label && names[names.length - 1] !== label) names.push(label);
    const surfaceKey = p.st || p.sf || 'inconnu';
    surfaces.set(surfaceKey, (surfaces.get(surfaceKey) ?? 0) + len);
  }

  return {
    total,
    smooth,
    green,
    unknownSurface,
    names,
    surfaces: [...surfaces.entries()].sort((a, b) => b[1] - a[1]),
  };
}
