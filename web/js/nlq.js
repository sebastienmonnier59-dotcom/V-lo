/**
 * Traduit une phrase en français vers les paramètres du planificateur.
 *
 * Volontairement déterministe et local : la question posée à un site de vélo
 * tient dans un vocabulaire fermé (un lieu, une distance ou une durée, un
 * revêtement, un type de voie). Un modèle de langage n'apporterait rien ici
 * qu'une centaine de lignes ne fassent déjà — et il ajouterait une latence,
 * une clé d'API et une dépendance réseau à chaque recherche.
 *
 * Le parseur rend toujours compte de ce qu'il a compris (`explain`) pour qu'on
 * puisse le corriger d'un clic plutôt que de deviner pourquoi il s'est trompé.
 */

const ACCENTS = /[̀-ͯ]/g;
export const norm = (s) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(ACCENTS, '')
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const NUMBER_WORDS = {
  une: 1, un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8,
  neuf: 9, dix: 10, quinze: 15, vingt: 20, trente: 30, quarante: 40, cinquante: 50,
  soixante: 60, 'quatre vingt': 80, cent: 100,
};

/** Vitesse de croisière retenue pour convertir une durée en distance. */
const SPEED_KMH = 15;

function parseDistance(text) {
  // « une quarantaine de km », « 40 km », « 40km », « max 60 kilomètres »
  const digits = text.match(/(\d{1,3})\s*(?:km|kilometres?|kilometre)/);
  if (digits) return { km: Number(digits[1]), why: `${digits[1]} km` };

  const aine = text.match(/(\w+)\s*aine de (?:km|kilometres?)/);
  if (aine) {
    const base = NUMBER_WORDS[aine[1].replace(/ain$/, '')] ?? NUMBER_WORDS[aine[1]];
    if (base) return { km: base, why: `environ ${base} km` };
  }
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word} (?:km|kilometres?)\\b`).test(text)) {
      return { km: value, why: `${value} km` };
    }
  }
  return null;
}

function parseDuration(text) {
  const explicit = text.match(/(\d{1,2})\s*(?:h|heures?)\b/);
  if (explicit) {
    const h = Number(explicit[1]);
    return { km: Math.round(h * SPEED_KMH), why: `${h} h de vélo ≈ ${Math.round(h * SPEED_KMH)} km` };
  }
  if (/demi[ -]?journee|matinee|apres[ -]?midi/.test(text)) {
    return { km: 45, why: 'une demi-journée ≈ 45 km' };
  }
  if (/journee|toute la journee/.test(text)) {
    return { km: 80, why: 'une journée ≈ 80 km' };
  }
  if (/week[ -]?end/.test(text)) {
    return { km: 120, why: 'un week-end ≈ 120 km par jour' };
  }
  return null;
}

/**
 * Repère le nom de gare. On privilégie les tournures explicites
 * (« depuis X ») puis on retombe sur la plus longue gare citée dans la phrase.
 */
function parseStation(text, stations) {
  const lead = text.match(
    /(?:depuis|au depart de|a partir de|en partant de|partir de|de la gare de|gare de)\s+([a-z0-9 \-]{2,40})/,
  );
  const candidates = [];

  if (lead) {
    const tail = lead[1].trim();
    for (const s of stations) {
      const n = norm(s.name);
      if (tail === n || tail.startsWith(`${n} `) || tail === `${n}`) candidates.push([n.length, s]);
    }
    if (!candidates.length) {
      for (const s of stations) {
        const n = norm(s.name);
        if (n.length >= 4 && tail.includes(n)) candidates.push([n.length, s]);
      }
    }
  }

  if (!candidates.length) {
    for (const s of stations) {
      const n = norm(s.name);
      // En dessous de 4 caractères, un nom de gare heurte trop de mots courants.
      if (n.length < 4) continue;
      if (new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`).test(text)) {
        candidates.push([n.length, s]);
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b[0] - a[0]);
  return candidates[0][1];
}

export function parseQuery(input, stations) {
  const text = norm(input);
  const explain = [];
  const result = {
    station: null,
    maxKm: null,
    surface: 'any', // any | smooth | ridable
    greenOnly: false,
    openOnly: true,
    mode: 'oneway', // oneway (gare à gare) | roundtrip (aller-retour)
    explain,
  };

  if (!text) return result;

  const station = parseStation(text, stations);
  if (station) {
    result.station = station;
    explain.push({ field: 'station', label: `Départ : ${station.name}` });
  }

  const dist = parseDistance(text) ?? parseDuration(text);
  if (dist) {
    result.maxKm = dist.km;
    explain.push({ field: 'maxKm', label: `Distance : ${dist.why}` });
  }

  // « roulant » et « confortable » sont plus permissifs que « lisse » : on les
  // teste d'abord, sans quoi « revêtement roulant » serait durci en asphalte.
  // Attention aussi à ne pas faire réagir « route » — il est dans « véloroute ».
  if (/roulant|sans gravier|pas de gravier|pas de terre|sans terre|confortable/.test(text)) {
    result.surface = 'ridable';
    explain.push({ field: 'surface', label: 'Revêtement : confortable (lisse ou roulant)' });
  } else if (/lisse|asphalte|bitume|goudron|velo de route|pneus fins|remorque|poussette|rollers?/.test(text)) {
    result.surface = 'smooth';
    explain.push({ field: 'surface', label: 'Revêtement : lisse uniquement' });
  } else if (/gravel|vtt|chemin|terre/.test(text)) {
    explain.push({ field: 'surface', label: 'Revêtement : tous acceptés' });
  }

  if (/voie verte|site propre|sans voiture|sans voitures|loin des voitures|a l ecart|en famille|enfants|securise/.test(text)) {
    result.greenOnly = true;
    explain.push({ field: 'greenOnly', label: 'Uniquement en site propre (RAVeL / voie verte)' });
  }

  if (/en famille|avec les enfants|avec des enfants|enfants/.test(text) && !dist) {
    result.maxKm = 25;
    explain.push({ field: 'maxKm', label: 'En famille : 25 km par défaut' });
  }

  if (/aller[ -]?retour|boucle|revenir|retour au point de depart|meme gare/.test(text)) {
    result.mode = 'roundtrip';
    explain.push({ field: 'mode', label: 'Aller-retour depuis la gare de départ' });
  } else if (/retour en train|autre gare|traversee|point a point|gare a gare/.test(text)) {
    result.mode = 'oneway';
    explain.push({ field: 'mode', label: 'Trajet gare à gare, retour en train' });
  }

  if (/projet|pas encore|futur|prevu|a venir/.test(text)) {
    result.openOnly = false;
    explain.push({ field: 'openOnly', label: 'Tronçons en projet inclus' });
  }

  return result;
}

/** Exemples affichés sous le champ de recherche, choisis pour couvrir le vocabulaire compris. */
export const EXAMPLES = [
  'Depuis Namur, 40 km de voie verte lisse, retour en train',
  'Une demi-journée au départ de Liège-Guillemins, en famille',
  '3h depuis Tours, revêtement roulant',
  'Aller-retour de 30 km depuis Charleroi-Central',
];
