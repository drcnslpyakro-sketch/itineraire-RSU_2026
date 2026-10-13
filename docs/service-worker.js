const CACHE_VERSION = "rsu-itineraires-v6";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./style.css",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // Un fichier manquant (ex. icône absente) ne doit pas faire échouer toute l'installation :
      // chaque ressource est mise en cache individuellement, les échecs sont seulement journalisés.
      .then((cache) => Promise.all(SHELL_FILES.map((f) =>
        cache.add(f).catch((e) => console.warn("SW: non mis en cache", f, e && e.message))
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("rsu-itineraires-") && k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isCoordDataRequest(url) {
  // Référentiel statique des localités (JSON GitHub) uniquement — jamais de données de ménages.
  // La liste vivante Apps Script (?action=list) n'est PLUS mise en cache ici : son URL contient le
  // jeton d'identité de l'opérateur (id_token) et un horodatage (t=), donc chaque requête créait une
  // entrée de cache inutilisable hors-ligne et conservait des jetons. Le repli hors-ligne du
  // référentiel est assuré par IndexedDB (app.js : idbSetMeta/idbGetMeta "localites").
  return url.includes("raw.githubusercontent.com");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = req.url;

  // Les écritures (POST vers Apps Script) ne passent jamais par le cache : le PWA gère
  // lui-même la file d'attente hors-ligne (voir app.js / IndexedDB).
  if (req.method !== "GET") return;

  // Référentiel des localités (coordonnées) : réseau d'abord, repli cache hors-ligne.
  if (isCoordDataRequest(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Authentification Google Identity Services (script, iframes, jetons) :
  // ne jamais intercepter, cela casserait le flux de connexion / renouvellement.
  if (url.includes("accounts.google.com") || url.includes("oauth2.googleapis.com")) {
    return;
  }

  // Toute autre requête vers Apps Script (ex. ?action=menages, données de ménages
  // potentiellement sensibles) : réseau uniquement, JAMAIS écrite dans le Cache Storage.
  // La mise en cache pour l'affichage hors-ligne reste gérée par app.js via IndexedDB
  // (state.menagesCache), qui n'est pas le Cache Storage du service worker.
  if (url.includes("script.google.com")) {
    return; // laisse passer au réseau par défaut, sans interception
  }

  // Fond de carte OSM / routage OSRM : réseau uniquement (données trop volumineuses/
  // changeantes pour être mises en cache utilement), on laisse échouer proprement hors-ligne.
  if (url.includes("tile.openstreetmap.org") || url.includes("router.project-osrm.org")) {
    return;
  }

  // App shell : cache d'abord (rapide, résilient hors-ligne), avec revalidation en arrière-plan
  // pour que les correctifs de app.js / config.js / style.css arrivent sans attendre un changement
  // de version du cache. Seules les réponses valides sont mises en cache.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});