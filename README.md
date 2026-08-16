# V-lo

Le RAVeL wallon et les véloroutes françaises, rendus utilisables pour décider d'une
sortie : partir d'une gare, savoir jusqu'où on peut aller **sur le réseau cyclable
lui-même**, sous quel revêtement, et sur des tronçons **réellement ouverts**.

Site statique, sans serveur ni base de données. Toutes les données viennent de
sources publiques et sont reconstruites par les scripts du dépôt.

---

## Le problème

Le RAVeL est très bien cartographié et très mal interrogeable. Les cartes existantes
répondent à « où passe l'itinéraire ? ». Elles ne répondent pas à la question qu'on se
pose réellement le vendredi soir :

> Je pars de telle gare, j'ai une demi-journée, je veux du plat sans voiture et je
> rentre en train. Où est-ce que je peux aller, et est-ce que c'est roulable ?

Trois écarts précis entre les données publiques et ce que les sites en font :

1. **L'état d'avancement est écrasé.** Le Service public de Wallonie publie pour
   chaque tronçon un champ `AVANCEMENT` : *Ouvert*, *Tracé arrêté*, *Projet*,
   *Potentiel*. Les rendus grand public tracent souvent une ligne continue. Sur les
   4 013 km de la base, **406 km ne sont pas ouverts** — et il suffit de 93 mètres au
   mauvais endroit pour couper une gare du réseau (c'est le cas de Namur).
2. **Les distances sont à vol d'oiseau ou routières.** Un halage qui suit un méandre
   fait 1,6 fois la distance directe. Annoncer « 37 km » quand le trajet en fait 60
   transforme une sortie en calvaire.
3. **Le revêtement n'est pas filtrable.** La donnée existe pourtant (`REVETEMENT`,
   `REVETEMENT_TYPE`, `LARGEUR`), et c'est elle qui décide si on y va en vélo de
   route, avec une remorque, ou pas du tout.

## Ce que fait V-lo

- **Partir d'une gare.** 3 910 gares belges et françaises, rattachées au réseau
  cyclable par projection sur le tracé — la distance d'accès gare → réseau est
  affichée en mètres.
- **Distance mesurée sur le réseau.** Dijkstra sur le graphe cyclable, recalculé à
  chaque changement de filtre. Le résultat liste les gares réellement atteignables,
  pas un cercle sur une carte.
- **Filtres qui contraignent le calcul, pas seulement l'affichage.** Si vous
  demandez du lisse, aucun mètre de gravier n'entrera dans l'itinéraire proposé.
- **Le site dit ce qui bloque.** Quand un filtre vide le résultat, V-lo remonte le
  tronçon exact qui coupe le réseau, sa longueur et la raison — « 93 m, marqué
  *tracé arrêté* » — avec un bouton pour lever cette contrainte-là. C'est la
  fonctionnalité la plus utile du site, et elle n'existe nulle part ailleurs.
- **Export GPX** de l'itinéraire calculé, aller simple ou aller-retour.
- **Recherche en français** : « 3h depuis Liège-Guillemins, revêtement roulant »
  règle la gare, la distance et les filtres, en affichant ce qui a été compris.

## Et l'IA dans tout ça ?

Question posée à l'origine du projet, réponse honnête : **le goulot d'étranglement
ici n'est pas le langage, c'est la donnée et la topologie.**

La barre de recherche comprend le français par un analyseur déterministe d'une
centaine de lignes (`web/js/nlq.js`). Le vocabulaire d'une sortie à vélo est fermé —
un lieu, une distance ou une durée, un revêtement, un type de voie. Un modèle de
langage y ajouterait une clé d'API, une latence réseau à chaque frappe et une part
d'imprévisibilité, pour un gain nul sur ces phrases. Il rend en échange ce qu'aucun
modèle ne donne : il affiche systématiquement son interprétation, et on la corrige
d'un clic.

Là où un modèle apporterait quelque chose, en revanche :

- **normaliser le revêtement des tronçons français**, où les tags OpenStreetMap sont
  hétérogènes et souvent absents au niveau des relations ;
- **résumer un itinéraire en prose** à partir des tronçons traversés ;
- **rapprocher les avis et signalements de terrain** (travaux, inondations) des
  tronçons concernés.

Ce sont des traitements de préparation de données, faits une fois au build — pas une
couche de conversation posée sur la carte.

## Ce qui existe déjà

Le projet ne prétend pas remplacer l'écosystème existant, qui est bon :

| Outil | Ce qu'il fait mieux | Ce qu'il ne fait pas |
| --- | --- | --- |
| [ravel.wallonie.be](https://ravel.wallonie.be/) | Référence officielle, fiches d'itinéraires, cartes papier, avis de travaux | Pas de calcul de distance sur le réseau, pas de filtre revêtement, pas de GPX |
| [Komoot](https://www.komoot.com/), [cycle.travel](https://cycle.travel/) | Routage porte-à-porte, relief, qualité de surface mondiale | Ignorent l'état d'avancement officiel ; ne raisonnent pas en gares |
| [Geovelo](https://geovelo.app/) | Excellent en usage urbain et quotidien | Orienté trajet utile plus que sortie loisir sur voie verte |
| [VéloTrain](https://velotrain.fr/) | Zones accessibles depuis une gare, compatibilité vélo des trains | France seulement, pas de filtre revêtement ni d'état d'avancement, pas de GPX |
| [BikeOnTrain](https://bikeontrain.belgiantrain.be/) (SNCB) | Emport du vélo à bord, places, accessibilité des quais | Ne planifie pas le parcours à vélo |

V-lo occupe l'espace laissé libre : **la question de faisabilité**, tranchée sur les
attributs officiels des tronçons. Il est complémentaire de BikeOnTrain (qui dit si le
train prend le vélo) et de Komoot (qui trace le détail du parcours).

## Données

| Jeu | Source | Licence |
| --- | --- | --- |
| Segments RAVeL et véloroutes de Wallonie | [Géoportail de la Wallonie](https://geoportail.wallonie.be/catalogue/f1ed4a9c-2d3f-4982-b3f8-42b4512d47f3.html) (SPW) — service ArcGIS REST | CC-BY 4.0 |
| Véloroutes nationales et EuroVelo en France | [OpenStreetMap](https://www.openstreetmap.org) via Overpass (`network=ncn\|icn`) | ODbL 1.0 |
| Gares belges | [iRail](https://api.irail.be) (données SNCB/NMBS) | CC0 |
| Gares françaises | [SNCF Open Data](https://ressources.data.sncf.com), jeu « liste-des-gares » | Licence Ouverte |

Le jeu ON3V publié sur data.gouv.fr n'a pas été mis à jour depuis 2017 : OpenStreetMap
est aujourd'hui la source la plus fraîche pour le réseau français.

## Utilisation

```bash
npm install          # maplibre-gl (embarqué dans web/vendor) + playwright (tests)
npm run fetch        # collecte : Wallonie, gares, puis France (long, reprenable)
npm run build        # topologie, graphe routable, index — écrit web/data/
npm run serve        # http://127.0.0.1:8777
```

`npm run fetch:france` interroge Overpass, qui renvoie fréquemment des 504. Le script
tourne par lots, alterne les miroirs, réessaie et **met chaque lot en cache sur
disque** : on peut l'interrompre et le relancer sans repartir de zéro. Un lot vide est
traité comme un échec et jamais mis en cache — sans quoi un timeout serveur se figerait
en trou dans les données.

### Vérifications

```bash
npm run check                 # cohérence du routage depuis une gare
npm run check -- Tournai
npm run smoke                 # parcours complet dans Chromium (serveur à démarrer avant)
```

`check-routing.mjs` compare pour chaque scénario de filtre la distance calculée sur le
réseau à la distance à vol d'oiseau, et échoue si un itinéraire est plus court que la
ligne droite — le symptôme d'un graphe faux.

## Architecture

```
scripts/
  fetch-ravel.mjs      SPW ArcGIS REST      → data/raw/ravel-segments.geojson
  fetch-france.mjs     Overpass (lots, cache) → data/raw/france-routes.geojson
  fetch-stations.mjs   iRail + SNCF          → data/raw/stations.geojson
  build-index.mjs      découpage, graphe, rattachement des gares → web/data/
  check-routing.mjs    contrôle de cohérence hors navigateur
  smoke-web.mjs        test de bout en bout dans Chromium
web/
  js/router.js         Dijkstra + description d'itinéraire (réutilisé par les tests)
  js/nlq.js            analyse des requêtes en français
  js/app.js            carte, filtres, résultats, GPX
  data/                artefacts servis au navigateur (versionnés)
```

Deux choix structurants :

**Le découpage aux intersections.** Les jeux publics décrivent des tronçons, pas un
graphe : une antenne qui rejoint une véloroute au milieu d'un tronçon ne partage
aucune extrémité avec elle. Sans découpage, le calcul voit un cul-de-sac là où il y a
une bifurcation. `build-index.mjs` coupe les tronçons aux jonctions en T et aux points
d'accroche des gares — ce qui fait passer la plus grande composante connexe de 1 802 à
2 084 nœuds, et le nombre de gares rattachées de 339 à 383.

**Le graphe part au client.** Il est assez petit (quelques dizaines de milliers
d'arêtes) pour qu'un Dijkstra complet tienne en quelques millisecondes dans le
navigateur. C'est ce qui permet de recalculer à chaque changement de filtre, donc de
poser des questions du type « et si j'exige du lisse ? » et d'avoir la réponse
immédiatement — sans serveur à héberger.

## Limites connues

- **Pas de relief.** Le RAVeL est plat par construction (halages, anciennes voies
  ferrées), pas les véloroutes françaises. Une couche d'altimétrie manque.
- **Revêtement français lacunaire.** Il est renseigné pour la quasi-totalité des
  tronçons wallons, rarement au niveau des relations OpenStreetMap françaises. Les
  filtres de revêtement sont donc bien plus sélectifs en France ; chaque itinéraire
  affiche sa part de « revêtement non renseigné ». Lire les tags des *ways* membres
  plutôt que ceux des relations corrigerait l'essentiel.
- **Le raccordement gare → réseau n'est pas calculé.** Sa longueur est affichée, son
  tracé non.
- **Pas d'horaires ni d'emport du vélo.** [BikeOnTrain](https://bikeontrain.belgiantrain.be/)
  et les fiches SNCF font ce travail mieux.
- **Wallonie uniquement côté belge.** La Flandre a son propre réseau à points-nœuds,
  publié séparément.

## Licence

Code sous licence MIT. Les données restent sous la licence de leur producteur et
doivent être créditées comme indiqué ci-dessus.
