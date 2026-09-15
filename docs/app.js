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
const state = {
  localites: [], markersByCle: {}, pending: [], itinerary: [],
  showUnverified: true, map: null, routeLine: null,
  currentMenageCle: null, menagesCache: {}
};

const els = {};
[
  "net-status","net-status-text","route-status","search-input","search-results",
  "map","fab-toggle","sync-badge","bottom-panel","itineraire-list","itineraire-hint",
  "sync-list","sync-hint","btn-sync-now","btn-recalc-route","btn-toggle-unverified","btn-open-gmaps",
  "btn-export-menages",
  "btn-sign-out","gps-modal","gps-modal-title","gps-modal-sub","gps-old-coords",
  "gps-new-coords","gps-accuracy","gps-cancel","gps-confirm",
  "menages-modal","menages-modal-title","menages-search","menages-list","menages-close",
  "menage-detail-modal","menage-detail-title","menage-detail-tel","menage-statut",
  "menage-date-rdv","menage-heure-rdv","menage-equipe","menage-observations",
  "menage-photo-input","menage-photo-preview","menage-cancel","menage-save"
].forEach(id => els[id] = document.getElementById(id));

/* ============================================================
   3. Chargement du référentiel : Apps Script (vivant) -> GitHub (repli) -> cache
   ============================================================ */
async function fetchLive() {
  const url = `${CFG.APPS_SCRIPT_URL}?action=list&id_token=${encodeURIComponent(auth.idToken || "")}&t=${Date.now()}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error("Apps Script HTTP " + res.status);
  const data = await res.json();
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
    </div>`;
}
function bindPopupActions(loc) {
  document.querySelectorAll('[data-action="add-itin"]').forEach(btn => btn.onclick = () => addToItinerary(btn.dataset.cle));
  document.querySelectorAll('[data-action="update-gps"]').forEach(btn => btn.onclick = () => openGpsModal(btn.dataset.cle));
  document.querySelectorAll('[data-action="menages"]').forEach(btn => btn.onclick = () => openMenagesModal(btn.dataset.cle));
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
  renderSearchResults(state.localites.filter(l => (l.nom||"").toLowerCase().includes(q) || (l.sous_prefecture||"").toLowerCase().includes(q)));
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
   8. Suivi terrain des ménages
   ============================================================ */
async function fetchMenages(cle) {
  const url = `${CFG.APPS_SCRIPT_URL}?action=menages&cle=${encodeURIComponent(cle)}&id_token=${encodeURIComponent(auth.idToken || "")}&t=${Date.now()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.auth_required) throw Object.assign(new Error(data.error), { authRequired: true });
  if (data.error) throw new Error(data.error);
  return data.menages || [];
}
async function openMenagesModal(cle) {
  const loc = state.localites.find(l => l.cle === cle);
  state.currentMenageCle = cle;
  els["menages-modal-title"].textContent = loc ? `Ménages — ${loc.nom}` : "Ménages";
  els["menages-search"].value = "";
  els["menages-list"].innerHTML = '<div class="empty-hint">Chargement…</div>';
  els["menages-modal"].classList.remove("hidden");
  let menages;
  try {
    menages = await fetchMenages(cle);
    state.menagesCache[cle] = menages;
  } catch (e) {
    if (e.authRequired) flagAuthProblem(e.message);
    menages = state.menagesCache[cle];
    if (!menages) {
      els["menages-list"].innerHTML = `<div class="empty-hint">Liste indisponible hors-ligne pour cette localité (pas encore consultée en ligne). ${e.message || ""}</div>`;
      return;
    }
  }
  applyMenagePendingOverrides(cle, menages);
  renderMenagesList(menages);
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
      m._enAttente = true;
    }
  });
}
function statutBadgeClass(statut) {
  return statut === "Enquête réalisée" ? "verifiee" : "attente";
}
function renderMenagesList(menages) {
  const q = els["menages-search"].value.trim().toLowerCase();
  const filtered = q ? menages.filter(m => (m.nom_chef_menage||"").toLowerCase().includes(q) || String(m.tel_chef_menage||"").includes(q)) : menages;
  if (filtered.length === 0) { els["menages-list"].innerHTML = '<div class="empty-hint">Aucun ménage trouvé.</div>'; return; }
  els["menages-list"].innerHTML = filtered.map(m => `
    <div class="list-row" data-id="${m.id_menage}" style="cursor:pointer;">
      <div><div class="name">${m.nom_chef_menage || "(nom non renseigné)"}</div>
      <div class="sub">${m.tel_chef_menage || "sans téléphone"} · ${m.village_quartier || ""}${m._enAttente ? " · en attente d'envoi" : ""}</div></div>
      <span class="badge ${statutBadgeClass(m.statut)}">${m.statut || "Non traité"}</span>
    </div>`).join("");
  els["menages-list"].querySelectorAll("[data-id]").forEach(row => row.addEventListener("click", () => openMenageDetail(row.dataset.id)));
}
els["menages-search"].addEventListener("input", () => renderMenagesList(state.menagesCache[state.currentMenageCle] || []));
els["menages-close"].addEventListener("click", () => els["menages-modal"].classList.add("hidden"));

let menageTarget = null, menagePhotoBase64 = null;
function openMenageDetail(idMenage) {
  const menages = state.menagesCache[state.currentMenageCle] || [];
  const m = menages.find(x => x.id_menage === idMenage);
  if (!m) return;
  menageTarget = m; menagePhotoBase64 = null;
  els["menage-detail-title"].textContent = m.nom_chef_menage || "Ménage";
  els["menage-detail-tel"].textContent = m.tel_chef_menage ? `Téléphone : ${m.tel_chef_menage}` : "Téléphone non renseigné";
  els["menage-statut"].value = m.statut || "Non traité";
  els["menage-date-rdv"].value = m.date_rdv || "";
  els["menage-heure-rdv"].value = m.heure_rdv || "";
  els["menage-equipe"].value = m.equipe || "";
  els["menage-observations"].value = m.observations || "";
  els["menage-photo-input"].value = "";
  els["menage-photo-preview"].innerHTML = m.lien_photo ? `<a href="${m.lien_photo}" target="_blank" rel="noopener">Photo existante</a>` : "";
  els["menages-modal"].classList.add("hidden");
  els["menage-detail-modal"].classList.remove("hidden");
}
els["menage-cancel"].addEventListener("click", () => { els["menage-detail-modal"].classList.add("hidden"); els["menages-modal"].classList.remove("hidden"); });

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
els["menage-photo-input"].addEventListener("change", async () => {
  const file = els["menage-photo-input"].files[0];
  if (!file) return;
  els["menage-photo-preview"].innerHTML = "Compression de la photo…";
  try {
    menagePhotoBase64 = await readAndCompressImage(file);
    els["menage-photo-preview"].innerHTML = `<img src="${menagePhotoBase64}" style="max-width:100%;border-radius:8px;">`;
  } catch (e) { els["menage-photo-preview"].innerHTML = "Échec de lecture de la photo."; }
});
els["menage-save"].addEventListener("click", async () => {
  if (!menageTarget) return;
  await idbAddPending({
    kind: "menage", cle: state.currentMenageCle, id_menage: menageTarget.id_menage, _row: menageTarget._row,
    statut: els["menage-statut"].value,
    date_rdv: els["menage-date-rdv"].value,
    heure_rdv: els["menage-heure-rdv"].value,
    equipe: els["menage-equipe"].value.trim(),
    observations: els["menage-observations"].value.trim(),
    photo_base64: menagePhotoBase64 || undefined,
    timestamp: new Date().toISOString()
  });
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
      payload.action = item.kind === "menage" ? "update_menage" : "update";
      const res = await fetch(CFG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
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
    if (menages) { applyMenagePendingOverrides(state.currentMenageCle, menages); renderMenagesList(menages); }
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
  els["sync-list"].innerHTML = state.pending.map(p => p.kind === "menage"
    ? `<div class="list-row"><div><div class="name">Ménage — ${p.statut || ""}</div><div class="sub">${p.photo_base64 ? "avec photo" : "sans photo"}</div></div><span class="badge attente">en attente</span></div>`
    : `<div class="list-row"><div><div class="name">${p.nom}</div><div class="sub">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div></div><span class="badge attente">en attente</span></div>`
  ).join("");
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
els["btn-export-menages"].addEventListener("click", async () => {
  const btn = els["btn-export-menages"];
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Génération en cours…";
  try {
    const url = `${CFG.APPS_SCRIPT_URL}?action=export_menages&id_token=${encodeURIComponent(auth.idToken || "")}&t=${Date.now()}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.auth_required) throw Object.assign(new Error(data.error), { authRequired: true });
    if (!data.ok) throw new Error(data.error || "Échec de l'export");
    window.open(data.url, "_blank");
  } catch (e) {
    if (e.authRequired) { flagAuthProblem(e.message); }
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