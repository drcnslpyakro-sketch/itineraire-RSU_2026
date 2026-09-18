"use strict";

/* ============================================================
   0. Stockage local (IndexedDB) — cache des données + file d'attente unifiée
   ============================================================ */
const DB_NAME = "rsu-itineraires";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetAllPending() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("pending", "readonly").objectStore("pending").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbAddPending(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("pending", "readwrite").objectStore("pending").add(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDeletePending(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("pending", "readwrite").objectStore("pending").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function idbSetMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("meta", "readwrite").objectStore("meta").put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function idbGetMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("meta", "readonly").objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

/* ============================================================
   1. Authentification Google (mode client-serveur multi-opérateurs)
   ============================================================
   Chaque opérateur se connecte une fois avec son compte Google. Le jeton
   d'identité obtenu (JWT) est renvoyé à chaque requête vers le serveur
   Apps Script, qui le vérifie auprès de Google puis contre la liste des
   comptes autorisés (PWA_Operateurs). Le décodage local sert uniquement à
   afficher qui est connecté ; la vérification qui compte se fait côté serveur.
*/
const auth = { idToken: null, email: null, name: null, picture: null, exp: 0 };

function decodeJwt(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(
    atob(base64).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
  );
  return JSON.parse(json);
}
function loadStoredAuth() {
  try {
    const raw = localStorage.getItem("googleAuth");
    if (!raw) return false;
    Object.assign(auth, JSON.parse(raw));
    return !!auth.idToken;
  } catch (e) { return false; }
}
function persistAuth() { localStorage.setItem("googleAuth", JSON.stringify(auth)); }
function clearAuth() {
  auth.idToken = null; auth.email = null; auth.name = null; auth.picture = null; auth.exp = 0;
  localStorage.removeItem("googleAuth");
}
function authNeedsRenewal() { return !auth.idToken || Date.now() > auth.exp - 5 * 60 * 1000; }

function initGoogleAuth() {
  return new Promise((resolve) => {
    (function waitForGis() {
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({
          client_id: CFG.GOOGLE_CLIENT_ID,
          callback: handleCredentialResponse,
          auto_select: true,
          cancel_on_tap_outside: false
        });
        resolve();
      } else {
        setTimeout(waitForGis, 200);
      }
    })();
  });
}
function renderSignInButton() {
  const el = document.getElementById("google-signin-button");
  el.innerHTML = "";
  google.accounts.id.renderButton(el, { theme: "outline", size: "large", text: "signin_with", locale: "fr", width: 280 });
  google.accounts.id.prompt();
}
function handleCredentialResponse(response) {
  const payload = decodeJwt(response.credential);
  auth.idToken = response.credential;
  auth.email = payload.email;
  auth.name = payload.name || payload.email;
  auth.picture = payload.picture || "";
  auth.exp = payload.exp * 1000;
  persistAuth();
  onSignedIn();
}
function signOut() {
  if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
  clearAuth();
  document.getElementById("login-overlay").classList.remove("hidden");
  document.getElementById("login-error").textContent = "";
  renderSignInButton();
  updateAccountCard();
}
function updateAccountCard() {
  document.getElementById("account-name").textContent = auth.name || "Non connecté";
  document.getElementById("account-email").textContent = auth.email || "";
  const pic = document.getElementById("account-picture");
  if (auth.picture) { pic.src = auth.picture; pic.style.display = "block"; } else { pic.style.display = "none"; }
}

/* ============================================================
   2. État applicatif
   ============================================================ */
const CFG = window.APP_CONFIG;
const MENAGES_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 heures
const MENAGES_CACHE_STORAGE_KEY = "menagesCacheV1";
const state = {
  localites: [], markersByCle: {}, pending: [], itinerary: [],
  showUnverified: true, map: null, routeLine: null,
  currentMenageCle: null, menagesCache: {}, menagesCacheTs: {}
};
loadMenagesCacheFromStorage();

const els = {};
[
  "net-status","net-status-text","route-status","search-input","search-results",
  "map","fab-toggle","sync-badge","bottom-panel","itineraire-list","itineraire-hint",
  "sync-list","sync-hint","btn-sync-now","btn-recalc-route","btn-toggle-unverified","btn-open-gmaps",
  "btn-export-menages","export-columns-modal","export-columns-list","export-columns-all",
  "export-columns-none","export-columns-cancel","export-columns-confirm",
  "btn-add-localite","btn-hidden-localites","add-localite-modal","add-localite-nom",
  "add-localite-type","add-localite-departement","add-localite-sous-prefecture",
  "add-localite-departement-options","add-localite-sous-prefecture-options",
  "add-localite-gps-coords","add-localite-gps-accuracy","add-localite-capture-gps",
  "add-localite-cancel","add-localite-save","hidden-localites-modal","hidden-localites-list",
  "hidden-localites-close",
  "btn-sign-out","gps-modal","gps-modal-title","gps-modal-sub","gps-old-coords",
  "gps-new-coords","gps-accuracy","gps-cancel","gps-confirm",
  "menages-modal","menages-modal-title","menages-search","menages-statut-filter","menages-export","menages-list","menages-close",
  "menage-detail-modal","menage-detail-title","menage-detail-tel","menage-statut","menage-statut-auto-hint",
  "menage-date-rdv","menage-heure-rdv","menage-equipe","menage-observations",
  "menage-remuneration","menage-education","menage-sante","menage-logement","menage-alimentation","menage-choc",
  "menage-photo-capture","menage-fichiers-input","menage-fichiers-preview","menage-cancel","menage-save"
  ,"menage-cancel-rdv",
  "file-preview-modal","file-preview-title","file-preview-body","file-preview-close","file-preview-open-external"
].forEach(id => els[id] = document.getElementById(id));

/* ============================================================
   3. Chargement du référentiel : Apps Script (vivant) -> GitHub (repli) -> cache
   ============================================================ */
// Si Apps Script plante hors des try/catch du script (ou si le déploiement n'est plus
// autorisé), il renvoie une page HTML au lieu de JSON — res.json() échoue alors avec un
// message technique illisible ("Unexpected token '<'"). On donne ici un message clair.
async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("Réponse invalide du serveur — le script Apps Script a probablement besoin d'être réautorisé ou redéployé (voir GUIDE_DEPLOIEMENT.md).");
  }
}

async function fetchLive() {
  const url = `${CFG.APPS_SCRIPT_URL}?action=list&id_token=${encodeURIComponent(auth.idToken || "")}&t=${Date.now()}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error("Apps Script HTTP " + res.status);
  const data = await parseJsonResponse(res);
  if (data.auth_required) throw Object.assign(new Error(data.error || "Reconnexion nécessaire"), { authRequired: true });
  if (data.error) throw new Error(data.error);
  if (!data || !Array.isArray(data.localites)) throw new Error("Réponse Apps Script invalide");
  return data.localites;
}
async function fetchGithub() {
  const res = await fetch(CFG.GITHUB_JSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("GitHub HTTP " + res.status);
  const data = await res.json();
  return data.localites;
}
async function loadLocalites() {
  let source = null, list = null;
  try { list = await fetchLive(); source = "live"; }
  catch (e) { console.warn("Source vivante indisponible, repli GitHub:", e.message); if (e.authRequired) flagAuthProblem(e.message); }
  if (!list) {
    try { list = await fetchGithub(); source = "github"; }
    catch (e) { console.warn("GitHub indisponible, repli cache local:", e.message); }
  }
  if (!list) {
    const cached = await idbGetMeta("localites");
    if (cached) { list = cached; source = "cache"; }
  }
  if (!list) throw new Error("Aucune source de données disponible (réseau et cache absents).");
  await idbSetMeta("localites", list);
  return { list, source };
}
function applyPendingOverrides(list, pending) {
  const byCle = {};
  list.forEach(l => byCle[l.cle] = { ...l });
  pending.filter(p => p.kind === "coord").forEach(p => {
    if (byCle[p.cle]) {
      byCle[p.cle].lat = p.lat; byCle[p.cle].lng = p.lng;
      byCle[p.cle].statut_coordonnees = "Vérifiée (terrain — en attente d'envoi)";
    }
  });
  pending.filter(p => p.kind === "localite_add" && p.localite).forEach(p => {
    if (!byCle[p.localite.cle]) byCle[p.localite.cle] = { ...p.localite };
  });
  pending.filter(p => p.kind === "localite_visibility").forEach(p => {
    if (byCle[p.cle]) byCle[p.cle].masquee = p.masquee;
  });
  return Object.values(byCle);
}
function flagAuthProblem(message) { els["route-status"].textContent = "Reconnexion nécessaire : " + message; }

/* ============================================================
   4. Carte
   ============================================================ */
function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([CFG.CENTRE.lat, CFG.CENTRE.lng], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 18 }).addTo(state.map);
  const startIcon = L.divIcon({ className: "", html: '<div class="pin start">★</div>', iconSize: [30,30], iconAnchor:[15,15] });
  L.marker([CFG.CENTRE.lat, CFG.CENTRE.lng], { icon: startIcon }).addTo(state.map)
    .bindPopup(`<div class="popup-title">${CFG.CENTRE.nom}</div><div class="popup-meta">Point de départ</div>`)
    .bindTooltip(CFG.CENTRE.nom, { permanent: true, direction: "top", offset: [0,-14], className: "marker-label" });
}
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function renderMarkers() {
  Object.values(state.markersByCle).forEach(m => state.map.removeLayer(m));
  state.markersByCle = {};
  state.localites.forEach(loc => {
    if (loc.masquee) return;
    if (loc.lat == null || loc.lng == null) return;
    const verifiee = (loc.statut_coordonnees || "").toLowerCase().includes("vérifiée");
    if (!verifiee && !state.showUnverified) return;
    const cls = verifiee ? "verifiee" : "attente";
    const icon = L.divIcon({ className: "", html: `<div class="pin ${cls}"></div>`, iconSize:[22,22], iconAnchor:[11,11] });
    const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(state.map);
    marker.bindTooltip(loc.nom, { permanent: false, direction: "top", offset: [0,-12], className: "marker-label" });
    marker.bindPopup(buildPopupHtml(loc));
    marker.on("popupopen", () => bindPopupActions(loc));
    state.markersByCle[loc.cle] = marker;
  });
}
function buildPopupHtml(loc) {
  const dist = loc.distance_km != null ? `${loc.distance_km} km du centre` : "distance inconnue";
  const statut = loc.statut_coordonnees || "Statut inconnu";
  return `
    <div class="popup-title">${loc.nom}</div>
    <div class="popup-meta">${loc.type || ""} · ${loc.sous_prefecture || ""}<br>${dist} · ${loc.nb_menages || 0} ménages<br><em>${statut}</em></div>
    <div class="popup-actions">
      <button class="secondary" data-action="add-itin" data-cle="${loc.cle}">Ajouter à l'itinéraire</button>
      <button class="secondary" data-action="menages" data-cle="${loc.cle}">Voir les ménages</button>
      <button class="primary" data-action="update-gps" data-cle="${loc.cle}">Actualiser la position</button>
      <button class="ghost" data-action="hide-localite" data-cle="${loc.cle}">Masquer</button>
    </div>`;
}
function bindPopupActions(loc) {
  document.querySelectorAll('[data-action="add-itin"]').forEach(btn => btn.onclick = () => addToItinerary(btn.dataset.cle));
  document.querySelectorAll('[data-action="update-gps"]').forEach(btn => btn.onclick = () => openGpsModal(btn.dataset.cle));
  document.querySelectorAll('[data-action="menages"]').forEach(btn => btn.onclick = () => openMenagesModal(btn.dataset.cle));
  document.querySelectorAll('[data-action="hide-localite"]').forEach(btn => btn.onclick = () => hideLocalite(btn.dataset.cle));
}

/* ============================================================
   5. Recherche de localités
   ============================================================ */
function renderSearchResults(items) {
  if (items.length === 0) {
    els["search-results"].innerHTML = '<div class="no-results">Aucune localité trouvée</div>';
    els["search-results"].classList.add("open");
    return;
  }
  els["search-results"].innerHTML = items.slice(0, 30).map(loc => {
    const verifiee = (loc.statut_coordonnees || "").toLowerCase().includes("vérifiée");
    const badge = loc.lat != null
      ? `<span class="badge ${verifiee ? "verifiee" : "attente"}">${verifiee ? "vérifiée" : "à confirmer"}</span>`
      : `<span class="badge attente">sans position</span>`;
    return `<div class="result-item" data-cle="${loc.cle}"><span class="result-name">${loc.nom}</span><span class="result-meta">${loc.sous_prefecture || ""} ${badge}</span></div>`;
  }).join("");
  els["search-results"].classList.add("open");
  els["search-results"].querySelectorAll(".result-item").forEach(el => el.addEventListener("click", () => selectFromSearch(el.dataset.cle)));
}
function selectFromSearch(cle) {
  const loc = state.localites.find(l => l.cle === cle);
  els["search-results"].classList.remove("open");
  els["search-input"].value = loc ? loc.nom : "";
  if (!loc) return;
  if (loc.lat != null && loc.lng != null) {
    state.map.flyTo([loc.lat, loc.lng], 13, { duration: 0.8 });
    const marker = state.markersByCle[cle];
    if (marker) marker.openPopup();
  } else {
    alert(`« ${loc.nom} » n'a pas encore de position connue. Utilisez « Actualiser la position » une fois sur place.`);
    openGpsModal(cle);
  }
}
els["search-input"].addEventListener("input", () => {
  const q = els["search-input"].value.trim().toLowerCase();
  if (q === "") { els["search-results"].classList.remove("open"); return; }
  renderSearchResults(state.localites.filter(l => !l.masquee && ((l.nom||"").toLowerCase().includes(q) || (l.sous_prefecture||"").toLowerCase().includes(q))));
});
els["search-input"].addEventListener("focus", () => { if (els["search-input"].value.trim() !== "") els["search-results"].classList.add("open"); });
document.addEventListener("click", (e) => { if (!document.getElementById("toolbar").contains(e.target)) els["search-results"].classList.remove("open"); });

/* ============================================================
   6. Itinéraire
   ============================================================ */
function addToItinerary(cle) { if (!state.itinerary.includes(cle)) state.itinerary.push(cle); renderItinerary(); computeRoute(); }
function removeFromItinerary(cle) { state.itinerary = state.itinerary.filter(c => c !== cle); renderItinerary(); computeRoute(); }
function renderItinerary() {
  const list = els["itineraire-list"];
  if (state.itinerary.length === 0) { els["itineraire-hint"].style.display = "block"; list.innerHTML = ""; return; }
  els["itineraire-hint"].style.display = "none";
  list.innerHTML = state.itinerary.map((cle, i) => {
    const loc = state.localites.find(l => l.cle === cle);
    if (!loc) return "";
    return `<div class="list-row"><div><div class="name">${i+1}. ${loc.nom}</div><div class="sub">${loc.sous_prefecture || ""}</div></div><button class="ghost" data-remove="${cle}" style="padding:6px 10px;">Retirer</button></div>`;
  }).join("");
  list.querySelectorAll("[data-remove]").forEach(btn => btn.onclick = () => removeFromItinerary(btn.dataset.remove));
}
async function computeRoute() {
  if (state.routeLine) { state.map.removeLayer(state.routeLine); state.routeLine = null; }
  const stops = state.itinerary.map(cle => state.localites.find(l => l.cle === cle)).filter(l => l && l.lat != null && l.lng != null);
  els["btn-open-gmaps"].disabled = stops.length === 0;
  if (stops.length === 0) {
    els["route-status"].textContent = navigator.onLine
      ? `${state.localites.length} localités chargées — sélectionnez des étapes pour tracer un itinéraire`
      : "Mode hors-ligne — référentiel local utilisé";
    return;
  }
  const coords = [[CFG.CENTRE.lat, CFG.CENTRE.lng], ...stops.map(s => [s.lat, s.lng])];
  state.routeLine = L.polyline(coords, { color: "#9a3f1f", weight: 3, opacity: 0.75, dashArray: "6 6" }).addTo(state.map);
  state.map.fitBounds(coords, { padding: [40, 40] });
  const totalHaversine = coords.slice(1).reduce((sum, c, i) => sum + haversineKm(...coords[i], ...c), 0);
  els["route-status"].textContent = `Itinéraire à vol d'oiseau : ${totalHaversine.toFixed(1)} km (${stops.length} étape${stops.length>1?"s":""})`;
  if (!navigator.onLine) return;
  try {
    const coordsParam = coords.map(([lat,lng]) => `${lng},${lat}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coordsParam}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes || !data.routes.length) throw new Error("Pas de route trouvée");
    const route = data.routes[0];
    const roadCoords = route.geometry.coordinates.map(([lng,lat]) => [lat,lng]);
    state.map.removeLayer(state.routeLine);
    state.routeLine = L.polyline(roadCoords, { color: "#9a3f1f", weight: 4, opacity: 0.9 }).addTo(state.map);
    const km = Math.round(route.distance / 100) / 10;
    const h = Math.floor(route.duration / 3600), m = Math.round((route.duration % 3600) / 60);
    els["route-status"].textContent = `Itinéraire routier (OSRM) — ${km} km, ${h > 0 ? h + " h " : ""}${m} min (${stops.length} étape${stops.length>1?"s":""})`;
  } catch (e) {
    console.warn("Routage OSRM indisponible:", e.message);
    els["route-status"].textContent += " · tracé routier indisponible, ligne directe affichée";
  }
}
els["btn-recalc-route"].addEventListener("click", computeRoute);
function openInGoogleMaps() {
  const stops = state.itinerary.map(cle => state.localites.find(l => l.cle === cle)).filter(l => l && l.lat != null && l.lng != null);
  if (stops.length === 0) return;
  const origin = `${CFG.CENTRE.lat},${CFG.CENTRE.lng}`;
  const destination = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lng}`;
  const waypoints = stops.slice(0, -1).map(s => `${s.lat},${s.lng}`).join("|");
  let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${origin}&destination=${destination}`;
  if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;
  window.open(url, "_blank");
}
els["btn-open-gmaps"].addEventListener("click", openInGoogleMaps);
els["btn-toggle-unverified"].addEventListener("click", () => {
  state.showUnverified = !state.showUnverified;
  els["btn-toggle-unverified"].textContent = state.showUnverified ? "Sans position : afficher" : "Sans position : masquer";
  renderMarkers();
});

/* ============================================================
   7. Actualisation terrain — position d'une localité (GPS)
   ============================================================ */
let gpsTarget = null, gpsCaptured = null;
function openGpsModal(cle) {
  const loc = state.localites.find(l => l.cle === cle);
  if (!loc) return;
  gpsTarget = loc; gpsCaptured = null;
  els["gps-modal-title"].textContent = `Actualiser : ${loc.nom}`;
  els["gps-old-coords"].textContent = (loc.lat != null) ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : "Aucune position connue";
  els["gps-new-coords"].textContent = "Capture en cours…";
  els["gps-accuracy"].textContent = "Précision : —";
  els["gps-confirm"].disabled = true;
  els["gps-modal"].classList.remove("hidden");
  if (!("geolocation" in navigator)) { els["gps-new-coords"].textContent = "Géolocalisation indisponible sur cet appareil"; return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gpsCaptured = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      els["gps-new-coords"].textContent = `${gpsCaptured.lat.toFixed(5)}, ${gpsCaptured.lng.toFixed(5)}`;
      els["gps-accuracy"].textContent = `Précision : ± ${Math.round(gpsCaptured.accuracy)} m`;
      els["gps-confirm"].disabled = false;
    },
    (err) => { els["gps-new-coords"].textContent = "Échec de la capture GPS"; els["gps-accuracy"].textContent = err.message || "Vérifiez l'autorisation de localisation"; },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}
els["gps-cancel"].addEventListener("click", () => els["gps-modal"].classList.add("hidden"));
els["gps-confirm"].addEventListener("click", async () => {
  if (!gpsTarget || !gpsCaptured) return;
  await idbAddPending({
    kind: "coord", cle: gpsTarget.cle, nom: gpsTarget.nom,
    lat: gpsCaptured.lat, lng: gpsCaptured.lng, accuracy: gpsCaptured.accuracy,
    timestamp: new Date().toISOString()
  });
  els["gps-modal"].classList.add("hidden");
  await refreshPendingAndData(false);
  const marker = state.markersByCle[gpsTarget.cle];
  if (marker) marker.openPopup();
  trySyncAll();
});

/* ============================================================
   8. Gestion partagée des localités
   ============================================================ */
function localiteKey(departement, sousPrefecture, nom) {
  return [departement, sousPrefecture, nom].map(value => String(value || "").trim().toUpperCase()).join("|");
}
function refreshLocaliteOptions() {
  const departments = [...new Set(state.localites.map(l => l.departement).filter(Boolean))].sort();
  const sousPrefectures = [...new Set(state.localites.map(l => l.sous_prefecture).filter(Boolean))].sort();
  els["add-localite-departement-options"].innerHTML = departments.map(value => `<option value="${value}"></option>`).join("");
  els["add-localite-sous-prefecture-options"].innerHTML = sousPrefectures.map(value => `<option value="${value}"></option>`).join("");
}
function openAddLocaliteModal() {
  refreshLocaliteOptions();
  ["add-localite-nom", "add-localite-departement", "add-localite-sous-prefecture"].forEach(id => { els[id].value = ""; });
  els["add-localite-type"].value = "Village";
  els["add-localite-gps-coords"].textContent = "Aucune";
  els["add-localite-gps-accuracy"].textContent = "—";
  addLocaliteGps = null;
  els["add-localite-modal"].classList.remove("hidden");
}
let addLocaliteGps = null;
els["btn-add-localite"].addEventListener("click", openAddLocaliteModal);
els["add-localite-cancel"].addEventListener("click", () => els["add-localite-modal"].classList.add("hidden"));
els["add-localite-capture-gps"].addEventListener("click", () => {
  if (!("geolocation" in navigator)) { els["add-localite-gps-coords"].textContent = "Géolocalisation indisponible"; return; }
  els["add-localite-gps-coords"].textContent = "Capture en cours…";
  navigator.geolocation.getCurrentPosition(pos => {
    addLocaliteGps = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
    els["add-localite-gps-coords"].textContent = `${addLocaliteGps.lat.toFixed(5)}, ${addLocaliteGps.lng.toFixed(5)}`;
    els["add-localite-gps-accuracy"].textContent = `± ${Math.round(addLocaliteGps.accuracy)} m`;
  }, err => { els["add-localite-gps-coords"].textContent = err.message || "Échec de la capture GPS"; }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
});
els["add-localite-save"].addEventListener("click", async () => {
  const nom = els["add-localite-nom"].value.trim();
  const departement = els["add-localite-departement"].value.trim();
  const sousPrefecture = els["add-localite-sous-prefecture"].value.trim();
  if (!nom || !departement || !sousPrefecture) { alert("Le nom, le département et la sous-préfecture sont requis."); return; }
  const cle = localiteKey(departement, sousPrefecture, nom);
  if (state.localites.some(l => l.cle === cle)) { alert("Cette localité existe déjà dans le référentiel."); return; }
  const localite = {
    cle, nom, type: els["add-localite-type"].value, departement: departement.toUpperCase(),
    sous_prefecture: sousPrefecture.toUpperCase(), nb_menages: 0,
    lat: addLocaliteGps ? addLocaliteGps.lat : null, lng: addLocaliteGps ? addLocaliteGps.lng : null,
    statut_coordonnees: addLocaliteGps ? "Vérifiée (terrain)" : "Position non vérifiée",
    source: "Ajout manuel (PWA)", masquee: false
  };
  await idbAddPending({ kind: "localite_add", localite, timestamp: new Date().toISOString(), accuracy: addLocaliteGps && addLocaliteGps.accuracy });
  els["add-localite-modal"].classList.add("hidden");
  await refreshPendingAndData(false);
  trySyncAll();
});
async function hideLocalite(cle, masquee = true) {
  const loc = state.localites.find(item => item.cle === cle);
  if (!loc) return;
  if (masquee && !confirm(`Masquer « ${loc.nom} » pour tous les opérateurs ?`)) return;
  await idbAddPending({ kind: "localite_visibility", cle, nom: loc.nom, masquee, timestamp: new Date().toISOString() });
  await refreshPendingAndData(false);
  trySyncAll();
}
function renderHiddenLocalites() {
  const hidden = state.localites.filter(loc => loc.masquee);
  els["hidden-localites-list"].innerHTML = hidden.length
    ? hidden.map(loc => `<div class="list-row"><div><div class="name">${loc.nom}</div><div class="sub">${loc.sous_prefecture || ""} · ${loc.departement || ""}</div></div><button class="secondary" data-unhide="${loc.cle}">Réafficher</button></div>`).join("")
    : '<div class="empty-hint">Aucune localité masquée.</div>';
  els["hidden-localites-list"].querySelectorAll("[data-unhide]").forEach(btn => btn.onclick = () => hideLocalite(btn.dataset.unhide, false));
}
els["btn-hidden-localites"].addEventListener("click", () => { renderHiddenLocalites(); els["hidden-localites-modal"].classList.remove("hidden"); });
els["hidden-localites-close"].addEventListener("click", () => els["hidden-localites-modal"].classList.add("hidden"));

/* ============================================================
   9. Suivi terrain des ménages
   ============================================================ */
/* ============================================================
   Cache des listes de ménages par localité, tamponné 24h
   ============================================================
   Objectif : rendre "Voir les ménages" rapide et accessible même hors-ligne,
   sans resolliciter le serveur à chaque ouverture. La liste chargée une fois
   reste utilisable pendant 24h (persistée dans localStorage, donc conservée
   même après fermeture de l'app), puis est considérée périmée et reforcée
   à se rafraîchir en ligne.
*/
function loadMenagesCacheFromStorage() {
  try {
    const raw = localStorage.getItem(MENAGES_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const now = Date.now();
    Object.keys(parsed).forEach(cle => {
      const entry = parsed[cle];
      if (entry && entry.ts && (now - entry.ts) < MENAGES_CACHE_TTL_MS) {
        state.menagesCache[cle] = entry.menages;
        state.menagesCacheTs[cle] = entry.ts;
      }
    });
  } catch (e) { /* cache corrompu ou indisponible : on repart à vide, sans bloquer l'app */ }
}
function saveMenagesCacheToStorage() {
  try {
    const out = {};
    Object.keys(state.menagesCache).forEach(cle => {
      out[cle] = { menages: state.menagesCache[cle], ts: state.menagesCacheTs[cle] || Date.now() };
    });
    localStorage.setItem(MENAGES_CACHE_STORAGE_KEY, JSON.stringify(out));
  } catch (e) { /* quota localStorage dépassé ou indisponible : le cache reste seulement en mémoire */ }
}
function isMenagesCacheFresh(cle) {
  const ts = state.menagesCacheTs[cle];
  return !!ts && (Date.now() - ts) < MENAGES_CACHE_TTL_MS;
}
function setMenagesCache(cle, menages) {
  state.menagesCache[cle] = menages;
  state.menagesCacheTs[cle] = Date.now();
  saveMenagesCacheToStorage();
}

async function fetchMenages(cle) {
  const url = `${CFG.APPS_SCRIPT_URL}?action=menages&cle=${encodeURIComponent(cle)}&id_token=${encodeURIComponent(auth.idToken || "")}&t=${Date.now()}`;
  const res = await fetch(url);
  const data = await parseJsonResponse(res);
  if (data.auth_required) throw Object.assign(new Error(data.error), { authRequired: true });
  if (data.error) throw new Error(data.error);
  return data.menages || [];
}
async function openMenagesModal(cle) {
  const loc = state.localites.find(l => l.cle === cle);
  state.currentMenageCle = cle;
  els["menages-modal-title"].textContent = loc ? `Ménages — ${loc.nom}` : "Ménages";
  els["menages-search"].value = "";
  els["menages-statut-filter"].value = "";
  els["menages-modal"].classList.remove("hidden");

  const cached = state.menagesCache[cle];
  if (cached && isMenagesCacheFresh(cle)) {
    // Cache frais (< 24h) : affichage instantané, sans attendre le réseau.
    applyMenagePendingOverrides(cle, cached);
    renderMenagesList();
    // Rafraîchissement silencieux en arrière-plan pour rester à jour, sans bloquer l'affichage.
    fetchMenages(cle).then(fresh => {
      setMenagesCache(cle, fresh);
      if (state.currentMenageCle === cle && !els["menages-modal"].classList.contains("hidden")) {
        applyMenagePendingOverrides(cle, fresh);
        renderMenagesList();
      }
    }).catch(() => { /* pas de réseau : le cache déjà affiché reste valable */ });
    return;
  }

  // Pas de cache, ou cache périmé (> 24h) : chargement bloquant comme avant.
  els["menages-list"].innerHTML = '<div class="empty-hint">Chargement…</div>';
  let menages;
  try {
    menages = await fetchMenages(cle);
    setMenagesCache(cle, menages);
  } catch (e) {
    if (e.authRequired) flagAuthProblem(e.message);
    menages = state.menagesCache[cle]; // repli sur un cache périmé plutôt que rien, si hors-ligne
    if (!menages) {
      els["menages-list"].innerHTML = `<div class="empty-hint">Liste indisponible hors-ligne pour cette localité (pas encore consultée en ligne). ${e.message || ""}</div>`;
      return;
    }
  }
  applyMenagePendingOverrides(cle, menages);
  renderMenagesList();
}
function applyMenagePendingOverrides(cle, menages) {
  state.pending.filter(p => p.kind === "menage" && p.cle === cle).forEach(o => {
    const m = menages.find(x => x.id_menage === o.id_menage);
    if (m) {
      if (o.statut !== undefined) m.statut = o.statut;
      if (o.date_rdv !== undefined) m.date_rdv = o.date_rdv;
      if (o.heure_rdv !== undefined) m.heure_rdv = o.heure_rdv;
      if (o.observations !== undefined) m.observations = o.observations;
      if (o.equipe !== undefined) m.equipe = o.equipe;
      if (o.remuneration !== undefined) m.remuneration = o.remuneration;
      if (o.education !== undefined) m.education = o.education;
      if (o.sante !== undefined) m.sante = o.sante;
      if (o.logement !== undefined) m.logement = o.logement;
      if (o.alimentation !== undefined) m.alimentation = o.alimentation;
      if (o.choc !== undefined) m.choc = o.choc;
      // Fichiers pas encore envoyés (pas de lien Drive tant que la synchronisation
      // n'a pas eu lieu) : on garde juste un compteur pour informer l'opérateur,
      // sans modifier m.lien_photo (qui ne contient que des fichiers réellement
      // envoyés et confirmés par le serveur).
      if (o.fichiers && o.fichiers.length) {
        m._fichiersEnAttente = (m._fichiersEnAttente || 0) + o.fichiers.length;
      }
      // Modification faite depuis cet appareil par l'opérateur connecté : on l'attribue
      // tout de suite (avant même la synchronisation), sinon la restriction d'affichage
      // par opérateur pourrait faire disparaître le ménage de sa propre liste.
      if (auth.email) m.dernier_operateur_email = auth.email;
      m._enAttente = true;
    }
  });
}
function statutBadgeClass(statut) {
  return statut === "Enquête réalisée" ? "verifiee" : "attente";
}
// Valeur spéciale du filtre "menages-statut-filter" : ne correspond à aucun
// vrai statut de traitement, mais à un critère orthogonal (numéro de
// téléphone du chef de ménage absent/vide). Doit rester identique côté
// serveur (voir SANS_NUMERO_FILTRE dans Code.gs) puisque c'est cette même
// chaîne qui est transmise telle quelle en paramètre "statut" de l'export.
const SANS_NUMERO_FILTRE = "__SANS_NUMERO__";
// Un numéro composé uniquement d'espaces, de tirets ou de zéros n'est pas un
// numéro exploitable sur le terrain : on le traite comme "sans numéro".
function telEstRenseigne(tel) {
  const s = String(tel || "").trim();
  return s !== "" && /[1-9]/.test(s);
}
function currentFilteredMenages() {
  const all = state.menagesCache[state.currentMenageCle] || [];
  const q = els["menages-search"].value.trim().toLowerCase();
  const statut = els["menages-statut-filter"].value;
  const monEmail = (auth.email || "").toLowerCase();
  return all.filter(m => {
    const statutActuel = m.statut || "Non traité";
    // "Non traité" reste visible de tous, sans restriction : ce sont les ménages
    // encore à prendre en charge par n'importe quel opérateur. Tout autre statut
    // n'est affiché que s'il a été posé par l'opérateur actuellement connecté —
    // pour ne pas encombrer chacun avec le travail déjà pris en charge par les autres.
    const mien = statutActuel === "Non traité" ||
      (m.dernier_operateur_email && String(m.dernier_operateur_email).toLowerCase() === monEmail);
    if (!mien) return false;
    const matchQ = !q ||
      (m.nom_chef_menage||"").toLowerCase().includes(q) ||
      String(m.tel_chef_menage||"").includes(q) ||
      String(m.id_menage||"").toLowerCase().includes(q);
    // "Sans numéro" est un critère à part, orthogonal au statut de traitement
    // (un ménage sans numéro peut être à n'importe quel statut) — on ne le
    // confond donc pas avec une comparaison d'égalité sur statutActuel.
    const matchStatut = !statut
      ? true
      : (statut === SANS_NUMERO_FILTRE ? !telEstRenseigne(m.tel_chef_menage) : statutActuel === statut);
    return matchQ && matchStatut;
  });
}
function renderMenagesList() {
  const filtered = currentFilteredMenages();
  if (filtered.length === 0) { els["menages-list"].innerHTML = '<div class="empty-hint">Aucun ménage trouvé.</div>'; return; }
  els["menages-list"].innerHTML = filtered.map(m => {
    const sansNumero = !telEstRenseigne(m.tel_chef_menage);
    return `
    <div class="list-row" data-id="${m.id_menage}" style="cursor:pointer;">
      <div><div class="name">${m.nom_chef_menage || "(nom non renseigné)"}</div>
      <div class="sub">${sansNumero ? `<span class="badge attente">sans numéro</span>` : m.tel_chef_menage} · ${m.village_quartier || ""}${m._enAttente ? " · en attente d'envoi" : ""}</div>
      <div class="sub" style="opacity:0.7;">${m.id_menage || ""}</div></div>
      <span class="badge ${statutBadgeClass(m.statut)}">${m.statut || "Non traité"}</span>
    </div>`;
  }).join("");
  els["menages-list"].querySelectorAll("[data-id]").forEach(row => row.addEventListener("click", () => openMenageDetail(row.dataset.id)));
}
els["menages-search"].addEventListener("input", () => renderMenagesList());
els["menages-statut-filter"].addEventListener("change", () => renderMenagesList());
els["menages-close"].addEventListener("click", () => els["menages-modal"].classList.add("hidden"));

let menageTarget = null, menageNewFiles = [];
function openMenageDetail(idMenage) {
  const menages = state.menagesCache[state.currentMenageCle] || [];
  const m = menages.find(x => x.id_menage === idMenage);
  if (!m) return;
  menageTarget = m; menageNewFiles = [];
  els["menage-detail-title"].textContent = m.nom_chef_menage || "Ménage";
  els["menage-detail-tel"].textContent = m.tel_chef_menage ? `Téléphone : ${m.tel_chef_menage}` : "Téléphone non renseigné";
  els["menage-statut"].value = m.statut || "Non traité";
  els["menage-date-rdv"].value = m.date_rdv || "";
  els["menage-heure-rdv"].value = m.heure_rdv || "";
  els["menage-equipe"].value = m.equipe || "";
  els["menage-observations"].value = m.observations || "";
  els["menage-remuneration"].value = m.remuneration || "";
  els["menage-education"].value = m.education || "";
  els["menage-sante"].value = m.sante || "";
  els["menage-logement"].value = m.logement || "";
  els["menage-alimentation"].value = m.alimentation || "";
  els["menage-choc"].value = m.choc || "";
  els["menage-photo-capture"].value = "";
  els["menage-fichiers-input"].value = "";
  els["menage-statut-auto-hint"].style.display = "none";
  renderMenageFichiersPreview();
  els["menages-modal"].classList.add("hidden");
  els["menage-detail-modal"].classList.remove("hidden");
}
els["menage-cancel"].addEventListener("click", () => { els["menage-detail-modal"].classList.add("hidden"); els["menages-modal"].classList.remove("hidden"); });
els["menage-cancel-rdv"].addEventListener("click", () => {
  els["menage-statut"].value = "RDV annulé (à reprogrammer)";
  els["menage-date-rdv"].value = "";
  els["menage-heure-rdv"].value = "";
});

function readAndCompressImage(file, maxWidth = 1280, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale; canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject; img.src = reader.result;
    };
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}
// Taille max d'un document (PDF) accepté : au-delà, l'envoi devient trop
// lourd pour une connexion mobile terrain. Les photos ne sont pas concernées
// par cette limite car elles sont systématiquement compressées avant envoi
// (voir readAndCompressImage).
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // 8 Mo

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function fileIconFor(type) { return type === "application/pdf" ? "📄" : "🖼️"; }

// Ajoute un fichier (photo ou document PDF) choisi par l'opérateur à la liste
// des fichiers de ce ménage en attente d'envoi. Les images sont compressées
// (comme avant, une seule photo à la fois) ; les PDF sont lus tels quels.
async function addMenageFile(file) {
  if (!file) return;
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  const isImage = !isPdf && (file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name || ""));
  if (!isPdf && !isImage) {
    alert(`« ${file.name} » : seuls les photos et les documents PDF sont acceptés.`);
    return;
  }
  if (isPdf && file.size > MAX_DOCUMENT_BYTES) {
    alert(`« ${file.name} » dépasse la taille maximale autorisée (8 Mo).`);
    return;
  }
  const entry = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, nom: file.name || (isPdf ? "document.pdf" : "photo.jpg") };
  try {
    if (isImage) {
      entry.base64 = await readAndCompressImage(file);
      entry.type = "image/jpeg";
    } else {
      entry.base64 = await readFileAsDataUrl(file);
      entry.type = "application/pdf";
    }
  } catch (e) {
    alert(`Échec de lecture de « ${file.name} ».`);
    return;
  }
  menageNewFiles.push(entry);
  // Un fichier vient d'être ajouté à l'enquête : le statut passera automatiquement
  // à "Enquête réalisée" à l'enregistrement (voir le bouton "menage-save"). On le
  // reflète tout de suite dans le sélecteur pour que l'opérateur le voie, tout en
  // le laissant libre de le changer ensuite si besoin (ex. RDV annulé malgré tout).
  els["menage-statut"].value = "Enquête réalisée";
  els["menage-statut-auto-hint"].style.display = "block";
  renderMenageFichiersPreview();
}
function removeMenageNewFile(id) {
  menageNewFiles = menageNewFiles.filter(f => f.id !== id);
  if (menageNewFiles.length === 0) els["menage-statut-auto-hint"].style.display = "none";
  renderMenageFichiersPreview();
}
function renderMenageFichiersPreview() {
  const container = els["menage-fichiers-preview"];
  const existants = (menageTarget && menageTarget.fichiers) || [];
  const parts = [];
  existants.forEach((f, i) => {
    const isImg = String(f.type || "").indexOf("image/") === 0;
    const thumb = isImg ? `<img class="file-thumb" src="${f.url}">` : `<div class="file-icon">${fileIconFor(f.type)}</div>`;
    parts.push(`
      <div class="file-chip" data-preview-existing="${i}">
        ${thumb}
        <span class="file-name">${f.nom || "Fichier"}</span>
        <span class="file-status">déjà envoyé</span>
      </div>`);
  });
  menageNewFiles.forEach(f => {
    const thumb = f.type === "image/jpeg"
      ? `<img class="file-thumb" src="${f.base64}">`
      : `<div class="file-icon">${fileIconFor(f.type)}</div>`;
    parts.push(`
      <div class="file-chip pending" data-preview-pending="${f.id}">
        ${thumb}
        <span class="file-name">${f.nom}</span>
        <span class="file-status">à envoyer</span>
        <button type="button" class="file-remove" data-remove-file="${f.id}" title="Retirer">×</button>
      </div>`);
  });
  if (menageTarget && menageTarget._fichiersEnAttente) {
    parts.push(`<div class="empty-hint">${menageTarget._fichiersEnAttente} fichier(s) d'un envoi précédent déjà en file d'attente de synchronisation.</div>`);
  }
  container.innerHTML = parts.length ? parts.join("") : '<div class="empty-hint">Aucun fichier pour ce ménage.</div>';
  container.querySelectorAll("[data-remove-file]").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeMenageNewFile(btn.dataset.removeFile);
  }));
  container.querySelectorAll("[data-preview-existing]").forEach(chip => chip.addEventListener("click", () => {
    const f = existants[Number(chip.dataset.previewExisting)];
    if (f) openFilePreview(f);
  }));
  container.querySelectorAll("[data-preview-pending]").forEach(chip => chip.addEventListener("click", () => {
    const f = menageNewFiles.find(x => x.id === chip.dataset.previewPending);
    if (f) openFilePreview(f);
  }));
}

/* ------------------------------------------------------------
   Consultation d'un fichier (photo ou PDF) directement dans l'app,
   sans dépendre d'un onglet externe — utilisé pour relire une fiche
   déjà renseignée (fichiers déjà envoyés) comme pour vérifier un
   fichier qu'on vient de sélectionner (pas encore envoyé).
   ------------------------------------------------------------ */
// Transforme un lien de partage Drive ("/view?...") en lien intégrable
// ("/preview"), utilisable dans un <iframe> pour afficher un PDF sans quitter
// l'app. Si le format n'est pas reconnu, renvoie l'URL telle quelle.
function driveEmbedUrl(url) {
  const match = /\/file\/d\/([^/]+)\//.exec(url || "");
  return match ? `https://drive.google.com/file/d/${match[1]}/preview` : url;
}
function openFilePreview(file) {
  const isImg = String(file.type || "").indexOf("image/") === 0;
  const isPdf = file.type === "application/pdf";
  const src = file.url || file.base64;
  els["file-preview-title"].textContent = file.nom || "Fichier";
  const body = els["file-preview-body"];
  if (isImg && src) {
    body.innerHTML = `<img src="${src}" alt="${file.nom || ""}">`;
  } else if (isPdf && src) {
    const embedSrc = file.url ? driveEmbedUrl(file.url) : src; // fichier local (base64) : affiché tel quel
    body.innerHTML = `<iframe src="${embedSrc}" title="${file.nom || "Document PDF"}"></iframe>`;
  } else {
    body.innerHTML = `<div class="no-preview">Aperçu indisponible pour ce fichier.</div>`;
  }
  const openLink = els["file-preview-open-external"];
  if (file.url) { openLink.href = file.url; openLink.style.display = "block"; }
  else { openLink.style.display = "none"; } // fichier pas encore envoyé : pas de lien Drive
  els["file-preview-modal"].classList.remove("hidden");
}
els["file-preview-close"].addEventListener("click", () => {
  els["file-preview-modal"].classList.add("hidden");
  els["file-preview-body"].innerHTML = ""; // libère la mémoire (notamment pour les grandes images)
});
els["menage-photo-capture"].addEventListener("change", async () => {
  const file = els["menage-photo-capture"].files[0];
  els["menage-photo-capture"].value = "";
  await addMenageFile(file);
});
els["menage-fichiers-input"].addEventListener("change", async () => {
  const files = Array.from(els["menage-fichiers-input"].files || []);
  els["menage-fichiers-input"].value = "";
  for (const file of files) await addMenageFile(file);
});
els["menage-save"].addEventListener("click", async () => {
  if (!menageTarget) return;
  // Si des fichiers ont été ajoutés lors de cette édition, l'enquête est
  // considérée réalisée : le statut est forcé à "Enquête réalisée" à
  // l'enregistrement, même si l'opérateur avait sélectionné autre chose.
  const statutFinal = menageNewFiles.length > 0 ? "Enquête réalisée" : els["menage-statut"].value;
  await idbAddPending({
    kind: "menage", cle: state.currentMenageCle, id_menage: menageTarget.id_menage, _row: menageTarget._row,
    statut: statutFinal,
    date_rdv: els["menage-date-rdv"].value,
    heure_rdv: els["menage-heure-rdv"].value,
    equipe: els["menage-equipe"].value.trim(),
    observations: els["menage-observations"].value.trim(),
    remuneration: els["menage-remuneration"].value.trim(),
    education: els["menage-education"].value.trim(),
    sante: els["menage-sante"].value.trim(),
    logement: els["menage-logement"].value.trim(),
    alimentation: els["menage-alimentation"].value.trim(),
    choc: els["menage-choc"].value.trim(),
    fichiers: menageNewFiles.length ? menageNewFiles.map(f => ({ nom: f.nom, type: f.type, base64: f.base64 })) : undefined,
    timestamp: new Date().toISOString()
  });
  menageNewFiles = [];
  els["menage-detail-modal"].classList.add("hidden");
  await refreshPendingAndData(false);
  trySyncAll();
});

/* ============================================================
   9. Synchronisation (coordonnées + ménages, file unifiée)
   ============================================================ */
async function trySyncAll() {
  const pending = await idbGetAllPending();
  if (pending.length === 0) return;
  if (!navigator.onLine) return;
  if (!auth.idToken) { flagAuthProblem("connectez-vous pour envoyer vos corrections en attente."); return; }

  for (const item of pending) {
    try {
      const payload = { ...item, idToken: auth.idToken };
      delete payload.id;
      if (item.kind === "localite_add") Object.assign(payload, item.localite);
      payload.action = item.kind === "menage" ? "update_menage"
        : item.kind === "localite_add" ? "add_localite"
          : item.kind === "localite_visibility" ? "hide_localite" : "update";
      const res = await fetch(CFG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      const data = await parseJsonResponse(res);
      if (data.ok) {
        await idbDeletePending(item.id);
      } else if (data.auth_required) {
        flagAuthProblem(data.error || "reconnexion nécessaire.");
        break;
      } else {
        console.warn("Rejet serveur pour", item.kind, item.cle || item.id_menage, data.error);
      }
    } catch (e) {
      console.warn("Échec de synchronisation, nouvel essai plus tard:", e.message);
      break;
    }
  }
  await refreshPendingAndData(true);
}
els["btn-sync-now"].addEventListener("click", trySyncAll);

async function refreshPendingAndData(refetchRemote) {
  state.pending = await idbGetAllPending();
  updateSyncBadge();
  renderSyncList();
  let base = await idbGetMeta("localites");
  if (refetchRemote) {
    try { const r = await loadLocalites(); base = r.list; } catch (e) { /* garde le cache */ }
  }
  state.localites = applyPendingOverrides(base || [], state.pending);
  renderMarkers();
  renderItinerary();
  if (state.currentMenageCle && !els["menages-modal"].classList.contains("hidden")) {
    const menages = state.menagesCache[state.currentMenageCle];
    if (menages) { applyMenagePendingOverrides(state.currentMenageCle, menages); renderMenagesList(); }
  }
}
function updateSyncBadge() {
  const n = state.pending.length;
  els["sync-badge"].textContent = n;
  els["sync-badge"].classList.toggle("hidden", n === 0);
}
function renderSyncList() {
  if (state.pending.length === 0) { els["sync-hint"].style.display = "block"; els["sync-list"].innerHTML = ""; return; }
  els["sync-hint"].style.display = "none";
  els["sync-list"].innerHTML = state.pending.map(p => {
    if (p.kind === "menage") return `<div class="list-row"><div><div class="name">Ménage — ${p.statut || ""}</div><div class="sub">${p.fichiers && p.fichiers.length ? p.fichiers.length + " fichier(s) joint(s)" : "sans fichier"}</div></div><span class="badge attente">en attente</span></div>`;
    if (p.kind === "localite_add") return `<div class="list-row"><div><div class="name">Nouvelle localité — ${p.localite.nom}</div><div class="sub">${p.localite.sous_prefecture || ""}</div></div><span class="badge attente">en attente</span></div>`;
    if (p.kind === "localite_visibility") return `<div class="list-row"><div><div class="name">${p.masquee ? "Masquage" : "Réaffichage"} — ${p.nom}</div></div><span class="badge attente">en attente</span></div>`;
    return `<div class="list-row"><div><div class="name">${p.nom}</div><div class="sub">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div></div><span class="badge attente">en attente</span></div>`;
  }).join("");
}

/* ============================================================
   10. État réseau + rafraîchissement périodique (visibilité multi-opérateurs)
   ============================================================ */
function updateNetStatus() {
  const online = navigator.onLine;
  els["net-status"].classList.toggle("offline", !online);
  els["net-status-text"].textContent = online ? "En ligne" : "Hors ligne";
  if (online) trySyncAll();
}
window.addEventListener("online", updateNetStatus);
window.addEventListener("offline", updateNetStatus);
setInterval(() => { if (navigator.onLine) trySyncAll(); }, CFG.SYNC_RETRY_MS);
setInterval(() => { if (navigator.onLine && auth.idToken) refreshPendingAndData(true); }, CFG.PULL_REFRESH_MS);

els["fab-toggle"].addEventListener("click", () => els["bottom-panel"].classList.toggle("collapsed"));
document.querySelectorAll(".panel-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel-view").forEach(v => v.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`.panel-view[data-view="${tab.dataset.tab}"]`).classList.add("active");
  });
});
els["btn-sign-out"].addEventListener("click", signOut);

/* ============================================================
   9. Export .xlsx des ménages travaillés (sélection de colonnes)
   ============================================================ */
let exportColumnsCache = null; // { key, label, required }[] — mis en cache après le 1er chargement
async function fetchExportColumns() {
  if (exportColumnsCache) return exportColumnsCache;
  const url = `${CFG.APPS_SCRIPT_URL}?action=export_columns&id_token=${encodeURIComponent(auth.idToken || "")}&t=${Date.now()}`;
  const res = await fetch(url);
  const data = await parseJsonResponse(res);
  if (data.auth_required) throw Object.assign(new Error(data.error), { authRequired: true });
  exportColumnsCache = data.columns || [];
  return exportColumnsCache;
}

// Décode le contenu .xlsx (base64) renvoyé par le serveur et déclenche un vrai
// téléchargement sur l'appareil — plus fiable que d'ouvrir un lien Drive, en
// particulier sur mobile où window.open() peut ouvrir un aperçu au lieu de
// télécharger selon le compte Google connecté dans le navigateur.
function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType || "application/octet-stream" });
}
function downloadXlsxToDevice(data) {
  if (!data.filedata || !data.mimeType) {
    // Le serveur n'a pas fourni de contenu direct (ancienne version du script,
    // ou export volontairement limité) : repli sur le lien Drive.
    if (data.url) window.open(data.url, "_blank");
    return;
  }
  try {
    const blob = base64ToBlob(data.filedata, data.mimeType);
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = data.filename || "export.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  } catch (e) {
    console.warn("Téléchargement direct impossible, repli sur le lien Drive:", e.message);
    if (data.url) window.open(data.url, "_blank");
  }
}
function renderExportColumnsList(columns) {
  els["export-columns-list"].innerHTML = columns.map(c => `
    <label style="display:flex; align-items:center; gap:8px; padding:5px 0;">
      <input type="checkbox" value="${c.key}" ${c.required ? "checked disabled" : "checked"} />
      <span>${c.label}${c.required ? " (toujours inclus)" : ""}</span>
    </label>
  `).join("");
}
let exportContext = { type: "operateur" };
async function openExportColumnsModal() {
  els["export-columns-list"].innerHTML = '<div class="empty-hint">Chargement…</div>';
  els["export-columns-modal"].classList.remove("hidden");
  try {
    const columns = await fetchExportColumns();
    renderExportColumnsList(columns);
  } catch (e) {
    if (e.authRequired) { els["export-columns-modal"].classList.add("hidden"); flagAuthProblem(e.message); }
    else els["export-columns-list"].innerHTML = `<div class="empty-hint">Erreur : ${e.message}</div>`;
  }
}
els["btn-export-menages"].addEventListener("click", () => {
  exportContext = { type: "operateur" };
  openExportColumnsModal();
});
els["menages-export"].addEventListener("click", () => {
  exportContext = { type: "localite", cle: state.currentMenageCle, statut: els["menages-statut-filter"].value };
  openExportColumnsModal();
});
els["export-columns-cancel"].addEventListener("click", () => els["export-columns-modal"].classList.add("hidden"));
els["export-columns-all"].addEventListener("click", () => {
  els["export-columns-list"].querySelectorAll("input[type=checkbox]").forEach(cb => { if (!cb.disabled) cb.checked = true; });
});
els["export-columns-none"].addEventListener("click", () => {
  els["export-columns-list"].querySelectorAll("input[type=checkbox]").forEach(cb => { if (!cb.disabled) cb.checked = false; });
});
els["export-columns-confirm"].addEventListener("click", async () => {
  const selected = Array.from(els["export-columns-list"].querySelectorAll("input[type=checkbox]:checked")).map(cb => cb.value);
  const btn = els["export-columns-confirm"];
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Génération en cours…";
  try {
    const colParam = encodeURIComponent(selected.join(","));
    let url;
    if (exportContext.type === "localite") {
      const statutParam = exportContext.statut ? `&statut=${encodeURIComponent(exportContext.statut)}` : "";
      url = `${CFG.APPS_SCRIPT_URL}?action=export_menages_localite&cle=${encodeURIComponent(exportContext.cle)}${statutParam}&colonnes=${colParam}&id_token=${encodeURIComponent(auth.idToken || "")}&t=${Date.now()}`;
    } else {
      url = `${CFG.APPS_SCRIPT_URL}?action=export_menages&colonnes=${colParam}&id_token=${encodeURIComponent(auth.idToken || "")}&t=${Date.now()}`;
    }
    const res = await fetch(url);
    const data = await parseJsonResponse(res);
    if (data.auth_required) throw Object.assign(new Error(data.error), { authRequired: true });
    if (!data.ok) throw new Error(data.error || "Échec de l'export");
    downloadXlsxToDevice(data);
    els["export-columns-modal"].classList.add("hidden");
  } catch (e) {
    if (e.authRequired) { els["export-columns-modal"].classList.add("hidden"); flagAuthProblem(e.message); }
    else alert("Export impossible : " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* ============================================================
   11. Démarrage
   ============================================================ */
async function onSignedIn() {
  document.getElementById("login-overlay").classList.add("hidden");
  updateAccountCard();
  await loadAppData();
}
async function loadAppData() {
  state.pending = await idbGetAllPending();
  updateSyncBadge();
  renderSyncList();
  try {
    const { list, source } = await loadLocalites();
    state.localites = applyPendingOverrides(list, state.pending);
    const labels = { live: "référentiel vivant (Google Sheet)", github: "référentiel GitHub", cache: "cache local (hors-ligne)" };
    els["route-status"].textContent = `${state.localites.length} localités chargées — source : ${labels[source]}`;
  } catch (e) {
    els["route-status"].textContent = "Impossible de charger le référentiel : " + e.message;
  }
  renderMarkers();
  renderItinerary();
  if (!els["hidden-localites-modal"].classList.contains("hidden")) renderHiddenLocalites();
  trySyncAll();
}
async function start() {
  initMap();
  updateNetStatus();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(e => console.warn("SW:", e));

  await initGoogleAuth();

  if (loadStoredAuth()) {
    document.getElementById("login-overlay").classList.add("hidden");
    updateAccountCard();
    await loadAppData();
    if (navigator.onLine && authNeedsRenewal()) renderSignInButton();
  } else {
    renderSignInButton();
  }
}
start();