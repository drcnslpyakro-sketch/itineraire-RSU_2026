// ============================================================
// CONFIGURATION — à personnaliser après déploiement
// ============================================================
window.APP_CONFIG = {
  // URL brute du fichier localites.json publié sur GitHub (repli hors-ligne
  // en lecture seule — ne contient jamais de données de ménage)
  GITHUB_JSON_URL: "https://raw.githubusercontent.com/drcnslpyakro-sketch/itineraire-RSU_2026/refs/heads/main/data/localites.json",

  // URL de déploiement du Google Apps Script (backend vivant, mode client-serveur)
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxfB5eXUs5u7YE8HI1An1U2RT7d0rm-9nWORJAJfPid-u9qRCiBUBy0ULvoQih7cKnN/exec",

  // Identifiant client OAuth Google (type "Web application"), créé dans Google
  // Cloud Console — voir GUIDE_DEPLOIEMENT.md §1. Chaque opérateur se connecte
  // avec son compte Google ; le serveur vérifie ce compte à chaque requête et
  // n'accepte que les adresses listées dans la feuille PWA_Operateurs.
  GOOGLE_CLIENT_ID: "874732891670-46hceq3sk7ca0ah4rnsr0ilkadiqhf0q.apps.googleusercontent.com",

  // Point central du district (utilisé pour le calcul des distances et le cadrage initial)
  CENTRE: { nom: "Yamoussoukro", lat: 6.824351068, lng: -5.284168113 },

  // Fréquence de nouvelle tentative de synchronisation automatique (ms)
  SYNC_RETRY_MS: 30000,

  // Fréquence de rafraîchissement du référentiel pour voir les mises à jour
  // des autres opérateurs même sans action locale (ms)
  PULL_REFRESH_MS: 120000
};
