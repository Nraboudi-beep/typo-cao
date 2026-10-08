/**
 * Serveur Typo Cao — service autonome pour l'espace atelier de Yuan.
 *
 * Indépendant de tout autre projet : il ne touche à rien d'existant et
 * s'attache uniquement au « moteur WhatsApp » (l'API Meta Cloud, via les
 * mêmes identifiants que ceux déjà utilisés sur le serveur).
 *
 * - Connexion : numéro WhatsApp → code à 6 chiffres envoyé sur WhatsApp
 *   (uniquement au numéro configuré) → session 24 h. Pas de mot de passe.
 * - Proxy GitHub : lit/écrit les fichiers du dépôt du catalogue ; le
 *   jeton GitHub ne quitte jamais ce serveur.
 * - Avis clients : reçus ici, publiés après validation dans l'atelier.
 *
 * Node >= 18, zéro dépendance.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } = require("node:crypto");

/* ---------- configuration (variables d'environnement) ---------- */
const CFG = {
  PORT: Number(process.env.PORT || 8787),
  ORIGINE_AUTORISEE: process.env.TYPO_CAO_ORIGINE || "https://nraboudi-beep.github.io",
  // un ou plusieurs numéros autorisés (séparés par des virgules) ; chacun reçoit son code sur son propre WhatsApp
  NUMEROS_AUTORISES: String(process.env.TYPO_CAO_WHATSAPP_TO || "").split(",").map(n => n.trim()).filter(Boolean),
  GITHUB_TOKEN: process.env.TYPO_CAO_GITHUB_TOKEN || "",
  SESSION_SECRET: process.env.TYPO_CAO_SESSION_SECRET || "",
  GITHUB_REPO: process.env.TYPO_CAO_GITHUB_REPO || "Nraboudi-beep/typo-cao",
  BRANCHES: (process.env.TYPO_CAO_GITHUB_BRANCHES || "typo-cao,main").split(",").map(b => b.trim()).filter(Boolean),
  // moteur WhatsApp : mêmes identifiants Meta que le reste du serveur
  WA_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN || "",
  WA_PHONE_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  WA_API: process.env.WHATSAPP_GRAPH_API_VERSION || "v21.0",
  WA_TEMPLATE: process.env.TYPO_CAO_OTP_TEMPLATE || "typo_cao_code",
  WA_LANG: process.env.TYPO_CAO_OTP_TEMPLATE_LANGUAGE || "fr",
  DATA_DIR: process.env.TYPO_CAO_DATA_DIR || "/data",
  PUBLIC_URL: (process.env.TYPO_CAO_PUBLIC_URL || "https://typo.atelierdedemain.fr").replace(/\/+$/, ""),
  SITE_URL: process.env.TYPO_CAO_SITE_URL || "https://nraboudi-beep.github.io/typo-cao/",
};

const configure = () =>
  Boolean(CFG.NUMEROS_AUTORISES.length && CFG.GITHUB_TOKEN && CFG.SESSION_SECRET && CFG.WA_TOKEN && CFG.WA_PHONE_ID);

/* ---------- petits utilitaires ---------- */
const sha256 = v => createHash("sha256").update(v).digest("hex");
const OTP_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const otps = new Map(); // numéro autorisé → { codeSha256, expiresAt, attempts }
const fenetres = new Map(); // limitation de débit par ip+action

function limiteDebit(cle, max, fenetreMs) {
  const now = Date.now();
  const e = fenetres.get(cle);
  if (!e || now - e.debut > fenetreMs) {
    fenetres.set(cle, { n: 1, debut: now });
    return true;
  }
  e.n += 1;
  return e.n <= max;
}

function normaliserNumero(saisie) {
  let n = String(saisie || "").replace(/[\s.()-]/g, "");
  if (n.startsWith("00")) n = "+" + n.slice(2);
  else if (/^0\d{9}$/.test(n)) n = "+33" + n.slice(1);
  else if (/^\d+$/.test(n)) n = "+" + n;
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}
// normalise les numéros autorisés une fois pour toutes
CFG.NUMEROS_AUTORISES = CFG.NUMEROS_AUTORISES.map(normaliserNumero).filter(Boolean);

/* ---------- journal des visites et des connexions ----------
 * Visites : compteurs anonymes par jour (aucune IP conservée — seulement une
 * empreinte salée, différente chaque jour, impossible à inverser).
 * Connexions : chaque tentative d'entrée dans l'espace atelier est consignée
 * (numéro et IP masqués). Consultable dans l'atelier, section « Journal ». */
const JOURNAL_FICHIER = path.join(CFG.DATA_DIR, "journal.json");
const JOURNAL_JOURS_MAX = 60;
const JOURNAL_CONNEXIONS_MAX = 200;
let journal = { jours: {}, connexions: [] };
let journalPersistant = false;
try {
  fs.mkdirSync(CFG.DATA_DIR, { recursive: true });
  if (fs.existsSync(JOURNAL_FICHIER)) {
    const j = JSON.parse(fs.readFileSync(JOURNAL_FICHIER, "utf8"));
    if (j && typeof j === "object")
      journal = { jours: j.jours && typeof j.jours === "object" ? j.jours : {}, connexions: Array.isArray(j.connexions) ? j.connexions : [] };
  }
  fs.writeFileSync(JOURNAL_FICHIER, JSON.stringify(journal));
  journalPersistant = true;
} catch (e) {
  console.error("Journal en mémoire seulement (dossier data inaccessible) :", e.message);
}

let journalTimer = null;
function journalSauver() {
  if (!journalPersistant || journalTimer) return;
  journalTimer = setTimeout(() => {
    journalTimer = null;
    fs.writeFile(JOURNAL_FICHIER, JSON.stringify(journal), err => {
      if (err) console.error("Écriture du journal impossible :", err.message);
    });
  }, 3000);
}

const jourCle = () => new Date().toISOString().slice(0, 10);

function visiteurEmpreinte(jour, ip, ua) {
  return createHmac("sha256", CFG.SESSION_SECRET || "journal").update(`${jour}|${ip}|${ua}`).digest("hex").slice(0, 16);
}

function enregistrerVisite(page, ip, ua) {
  const jour = jourCle();
  const j = journal.jours[jour] || (journal.jours[jour] = { pages: {}, appareils: {}, visiteurs: [] });
  j.pages[page] = (j.pages[page] || 0) + 1;
  const appareil = /mobile|android|iphone|ipad/i.test(ua) ? "mobile" : "ordinateur";
  j.appareils[appareil] = (j.appareils[appareil] || 0) + 1;
  const emp = visiteurEmpreinte(jour, ip, ua);
  if (!j.visiteurs.includes(emp) && j.visiteurs.length < 5000) j.visiteurs.push(emp);
  const cles = Object.keys(journal.jours).sort();
  while (cles.length > JOURNAL_JOURS_MAX) delete journal.jours[cles.shift()];
  journalSauver();
}

function masquerNumero(saisie) {
  const n = String(saisie || "").replace(/[^\d+]/g, "");
  if (!n) return "(vide)";
  if (n.length <= 4) return n[0] + "•••";
  return n.slice(0, 3) + "•".repeat(Math.min(Math.max(n.length - 5, 2), 10)) + n.slice(-2);
}

function masquerIp(ip) {
  const s = String(ip || "");
  if (s.includes(".")) { const p = s.split("."); return `${p[0]}.${p[1] || "•"}.•.•`; }
  return s.split(":").slice(0, 2).join(":") + ":…";
}

function enregistrerConnexion(type, ip, numeroSaisi) {
  journal.connexions.push({
    date: new Date().toISOString(),
    type,
    ...(numeroSaisi !== undefined ? { numero: masquerNumero(numeroSaisi) } : {}),
    ip: masquerIp(ip),
  });
  if (journal.connexions.length > JOURNAL_CONNEXIONS_MAX)
    journal.connexions.splice(0, journal.connexions.length - JOURNAL_CONNEXIONS_MAX);
  journalSauver();
}

/* ---------- aperçus de création (image + message prêt à envoyer) ----------
 * Le site fabrique une petite image filigranée de la création et l'envoie ici.
 * On la sert sur /a/<id> (page avec vignette, visible dans WhatsApp) et on
 * garde le texte du message pour /w/<id> : une redirection vers la
 * conversation WhatsApp prête à envoyer — c'est ce lien court que le QR encode. */
const APERCUS_DIR = path.join(CFG.DATA_DIR, "apercus");
const APERCU_TTL_MS = 60 * 24 * 60 * 60_000;
let apercusPersistants = false;
try { fs.mkdirSync(APERCUS_DIR, { recursive: true }); apercusPersistants = true; }
catch (e) { console.error("Aperçus désactivés (dossier inaccessible) :", e.message); }

function apercusPurger() {
  if (!apercusPersistants) return;
  try {
    const limite = Date.now() - APERCU_TTL_MS;
    for (const f of fs.readdirSync(APERCUS_DIR)) {
      const p = path.join(APERCUS_DIR, f);
      try { if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
apercusPurger();
setInterval(apercusPurger, 24 * 60 * 60_000).unref();

const idValide = id => typeof id === "string" && /^[A-Za-z0-9]{10}$/.test(id);
function nouvelId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alphabet[randomInt(0, alphabet.length)];
  return s;
}
const echapperHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function lireApercuMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(APERCUS_DIR, id + ".json"), "utf8")); } catch { return null; }
}

function pageApercu(id, meta) {
  const img = `${CFG.PUBLIC_URL}/a/${id}.jpg`;
  const video = meta && meta.video ? `${CFG.PUBLIC_URL}/a/${id}.${meta.video}` : "";
  const titre = meta && meta.titre ? `Aperçu Typo Cao — ${meta.titre}` : "Aperçu Typo Cao";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${echapperHtml(titre)}</title>
<meta property="og:title" content="${echapperHtml(titre)}"><meta property="og:type" content="website">
<meta property="og:image" content="${img}"><meta property="og:image:type" content="image/jpeg">${video ? `
<meta property="og:video" content="${video}"><meta property="og:video:type" content="video/${meta.video}">` : ""}
<meta property="og:description" content="Aperçu filigrané d'une création Typo Cao. La version finale est réalisée par l'atelier.">
<meta name="robots" content="noindex">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500;9..144,600&family=Outfit:wght@300;400;500;600&display=swap">
<style>body{margin:0;background:#ece5d8;background-image:radial-gradient(1200px 600px at 50% -200px,#f6f0e4 0%,#ece5d8 70%);color:#2b2218;font:300 17px/1.6 Outfit,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}
main{width:min(100%,860px);text-align:center}.marque{font-family:Fraunces,Georgia,serif;letter-spacing:.14em;font-size:1.1rem;color:#2b2218;text-decoration:none}.marque b{color:#8a6330;font-weight:600}
.cadre{margin:18px auto 0;border-radius:12px;overflow:hidden;box-shadow:0 24px 60px -24px rgba(90,62,28,.45);background:#000}
img.apercu{max-width:100%;height:auto;display:block}
h1{font:500 1.5rem Fraunces,Georgia,serif;margin:20px 0 4px}p{color:#8d7d67;margin:0 0 14px}a.cta{display:inline-block;margin-top:6px;color:#fdf9f1;background:linear-gradient(170deg,#a87c3f,#8a6330);border-radius:6px;padding:10px 20px;text-decoration:none;font-size:.9rem;letter-spacing:.08em}</style></head>
<body><main><a class="marque" href="${echapperHtml(CFG.SITE_URL)}">TYPO <b>CAO</b></a>
<div class="cadre" id="cadre">${video ? `<video id="lecteur" controls playsinline preload="metadata" poster="${img}" style="width:100%;display:block"><source src="${video}" type="video/${meta.video}"></video>` : `<img class="apercu" src="${img}" alt="Aperçu de la création">`}</div>
<h1>${echapperHtml(titre)}</h1>
<p>Aperçu filigrané généré sur le site — la version finale, propre, est réalisée par l'atelier.</p>
<a class="cta" href="${echapperHtml(CFG.SITE_URL)}">Composer la mienne →</a></main>${video ? `
<script src="${echapperHtml(CFG.SITE_URL.replace(/\/+$/, ""))}/lecteur-typo.js"></script>
<script>
(function(){
  var el = document.getElementById("lecteur");
  if (!window.LecteurTypo || !el) return;
  LecteurTypo.monter(el, { site: ${JSON.stringify(CFG.SITE_URL)}, poster: ${JSON.stringify(img)} }).then(function(p){
    if (!p) return;
    p.on("loadedmetadata", function(){
      var r = p.videoWidth() / p.videoHeight();
      if (r) document.getElementById("cadre").style.maxWidth = "min(100%, calc(72vh * " + r + "))";
    });
  });
})();
</script>` : ""}</body></html>`;
}

class ErreurApp extends Error {
  constructor(statut, code, message) {
    super(message);
    this.statut = statut;
    this.code = code;
  }
}

/* ---------- moteur WhatsApp (API Meta Cloud) ---------- */
async function envoyerCodeWhatsApp(code, destinataire) {
  const r = await fetch(`https://graph.facebook.com/${CFG.WA_API}/${CFG.WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CFG.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: destinataire.slice(1), // E.164 sans le « + »
      type: "template",
      template: {
        name: CFG.WA_TEMPLATE,
        language: { code: CFG.WA_LANG },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      },
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("Envoi WhatsApp refusé :", r.status, detail.slice(0, 300));
    throw new ErreurApp(502, "WHATSAPP_SEND_FAILED", "L'envoi WhatsApp a échoué");
  }
}

/**
 * Second canal : le même code en texte libre. WhatsApp ne le délivre que si le
 * destinataire a écrit au numéro de l'atelier dans les 24 h (sinon il est
 * accepté puis ignoré, sans erreur). Utile quand le template d'authentification
 * n'atteint pas certains téléphones. Échec silencieux : le template reste la voie principale.
 */
async function envoyerCodeTexte(code, destinataire) {
  try {
    await fetch(`https://graph.facebook.com/${CFG.WA_API}/${CFG.WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CFG.WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: destinataire.slice(1),
        type: "text",
        text: { body: `Code de connexion à l'atelier Typo Cao : ${code}\nValable 5 minutes. Ne le partage à personne.` },
      }),
    });
  } catch (e) {
    console.error("Envoi du code en texte impossible :", e.message);
  }
}

/* ---------- sessions ---------- */
function creerJeton() {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: "atelier", exp })).toString("base64url");
  const sig = createHmac("sha256", CFG.SESSION_SECRET).update(payload).digest("base64url");
  return { jeton: `${payload}.${sig}`, expireLe: new Date(exp).toISOString() };
}

function verifierSession(enTete) {
  const token = enTete && enTete.startsWith("Bearer ") ? enTete.slice(7).trim() : "";
  const [payload, sig] = token.split(".");
  if (!payload || !sig) throw new ErreurApp(401, "TYPO_CAO_SESSION_REQUIRED", "Connexion requise");
  const attendu = createHmac("sha256", CFG.SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(attendu), b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new ErreurApp(401, "TYPO_CAO_SESSION_INVALID", "Session invalide, reconnecte-toi");
  let p;
  try { p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new ErreurApp(401, "TYPO_CAO_SESSION_INVALID", "Session invalide, reconnecte-toi"); }
  if (!p.exp || Date.now() > p.exp)
    throw new ErreurApp(401, "TYPO_CAO_SESSION_EXPIRED", "Session expirée, reconnecte-toi");
}

/* ---------- proxy GitHub ---------- */
const GH = "https://api.github.com";
const ghHeaders = () => ({
  Authorization: `Bearer ${CFG.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "typo-cao-serveur",
});

function cheminValide(p) {
  return typeof p === "string" && p.length <= 256 && /^[\w][\w./ ()'-]*$/u.test(p) && !p.includes("..");
}

async function ghLire(path, branche) {
  const r = await fetch(`${GH}/repos/${CFG.GITHUB_REPO}/contents/${encodeURI(path)}?ref=${branche}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new ErreurApp(502, "TYPO_CAO_GITHUB_READ_FAILED", "Lecture GitHub impossible");
  return r.json();
}

async function ghEcrire(path, contentB64, message) {
  for (const branche of CFG.BRANCHES) {
    const existant = await ghLire(path, branche);
    const r = await fetch(`${GH}/repos/${CFG.GITHUB_REPO}/contents/${encodeURI(path)}`, {
      method: "PUT",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: contentB64, branch: branche, ...(existant ? { sha: existant.sha } : {}) }),
    });
    if (!r.ok) throw new ErreurApp(502, "TYPO_CAO_GITHUB_WRITE_FAILED", `Écriture GitHub impossible (branche ${branche})`);
  }
}

/* ---------- lecture du corps JSON ---------- */
function lireCorps(req, maxOctets = 1_200_000) {
  return new Promise((resolve, reject) => {
    let taille = 0;
    const morceaux = [];
    req.on("data", c => {
      taille += c.length;
      if (taille > maxOctets) { reject(new ErreurApp(413, "REQUEST_TOO_LARGE", "Requête trop volumineuse")); req.destroy(); return; }
      morceaux.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(morceaux).toString("utf8") || "{}")); }
      catch { reject(new ErreurApp(400, "BAD_JSON", "Corps JSON invalide")); }
    });
    req.on("error", () => reject(new ErreurApp(400, "BAD_REQUEST", "Requête interrompue")));
  });
}

function lireBrut(req, maxOctets) {
  return new Promise((resolve, reject) => {
    let taille = 0;
    const morceaux = [];
    req.on("data", c => {
      taille += c.length;
      if (taille > maxOctets) { reject(new ErreurApp(413, "REQUEST_TOO_LARGE", "Fichier trop volumineux")); req.destroy(); return; }
      morceaux.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(morceaux)));
    req.on("error", () => reject(new ErreurApp(400, "BAD_REQUEST", "Requête interrompue")));
  });
}

const VIDEO_MAX_OCTETS = 40 * 1024 * 1024;
const VIDEO_TYPES = { "video/mp4": "mp4", "video/webm": "webm" };

function servirFichier(req, chemin, type) {
  let st; try { st = fs.statSync(chemin); } catch { throw new ErreurApp(404, "APERCU_INTROUVABLE", "Fichier introuvable"); }
  const entetes = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400" };
  const range = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const debut = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const fin = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (debut >= st.size || debut > fin) return { __brut: true, statut: 416, entetes: { "Content-Range": `bytes */${st.size}` }, corps: "" };
    return { __brut: true, statut: 206, entetes: { ...entetes, "Content-Range": `bytes ${debut}-${fin}/${st.size}`, "Content-Length": fin - debut + 1 }, corps: fs.createReadStream(chemin, { start: debut, end: fin }) };
  }
  return { __brut: true, statut: 200, entetes: { ...entetes, "Content-Length": st.size }, corps: fs.createReadStream(chemin) };
}

/* ---------- routes ---------- */
async function router(req, res, url, ip) {
  const chemin = url.pathname.replace(/\/+$/, "");

  if (req.method === "GET" && chemin === "/api/typo-cao/status") {
    return { configure: configure() };
  }

  // --- aperçus : dépôt (site), page (/a/<id>), image (/a/<id>.jpg), redirection WhatsApp (/w/<id>)
  if (req.method === "POST" && chemin === "/api/typo-cao/apercu") {
    if (!apercusPersistants) throw new ErreurApp(503, "APERCU_INDISPONIBLE", "Aperçus indisponibles");
    if (!limiteDebit(`apercu|${ip}`, 40, 60 * 60_000))
      throw new ErreurApp(429, "APERCU_RATE_LIMITED", "Trop d'aperçus, réessaie plus tard");
    const corps = await lireCorps(req, 700_000);
    const numero = String(corps.numero || "").replace(/\D/g, "");
    const texte = String(corps.texte || "").slice(0, 1500);
    const titre = String(corps.titre || "").slice(0, 40);
    if (!/^\d{8,15}$/.test(numero)) throw new ErreurApp(400, "NUMERO_INVALIDE", "Numéro invalide");
    let id = idValide(corps.id) && lireApercuMeta(corps.id) ? corps.id : null;
    if (!id) {
      const b64 = String(corps.imageB64 || "");
      if (!/^\/9j\/[A-Za-z0-9+/]+=*$/.test(b64) || b64.length > 560_000)
        throw new ErreurApp(400, "IMAGE_INVALIDE", "Image JPEG attendue (≤ 400 Ko)");
      id = nouvelId();
      fs.writeFileSync(path.join(APERCUS_DIR, id + ".jpg"), Buffer.from(b64, "base64"));
    }
    fs.writeFileSync(path.join(APERCUS_DIR, id + ".json"), JSON.stringify({ numero, texte, titre, date: new Date().toISOString() }));
    res.statusCode = 201;
    return { id, page: `${CFG.PUBLIC_URL}/a/${id}`, image: `${CFG.PUBLIC_URL}/a/${id}.jpg`, whatsapp: `${CFG.PUBLIC_URL}/w/${id}` };
  }
  // vidéo d'aperçu fabriquée par le moteur (PUT binaire, ≤ 40 Mo)
  {
    const mv = req.method === "PUT" && chemin.match(/^\/api\/typo-cao\/apercu\/([A-Za-z0-9]{10})\/video$/);
    if (mv) {
      const id = mv[1];
      const meta = lireApercuMeta(id);
      if (!meta) throw new ErreurApp(404, "APERCU_INTROUVABLE", "Aperçu introuvable");
      if (!limiteDebit(`apercu-video|${ip}`, 12, 60 * 60_000))
        throw new ErreurApp(429, "APERCU_RATE_LIMITED", "Trop d'envois, réessaie plus tard");
      const ext = VIDEO_TYPES[String(req.headers["content-type"] || "").split(";")[0].trim()];
      if (!ext) throw new ErreurApp(415, "VIDEO_TYPE", "Vidéo MP4 ou WebM attendue");
      const data = await lireBrut(req, VIDEO_MAX_OCTETS);
      if (data.length < 1000) throw new ErreurApp(400, "VIDEO_VIDE", "Vidéo vide");
      for (const e of Object.values(VIDEO_TYPES)) { try { fs.unlinkSync(path.join(APERCUS_DIR, `${id}.${e}`)); } catch {} }
      fs.writeFileSync(path.join(APERCUS_DIR, `${id}.${ext}`), data);
      fs.writeFileSync(path.join(APERCUS_DIR, id + ".json"), JSON.stringify({ ...meta, video: ext, videoOctets: data.length }));
      return { id, video: `${CFG.PUBLIC_URL}/a/${id}.${ext}`, page: `${CFG.PUBLIC_URL}/a/${id}` };
    }
  }
  {
    const m = req.method === "GET" && chemin.match(/^\/(a|w)\/([A-Za-z0-9]{10})(\.jpg|\.mp4|\.webm)?$/);
    if (m) {
      const [, type, id, ext] = m;
      const meta = lireApercuMeta(id);
      if (!meta) throw new ErreurApp(404, "APERCU_INTROUVABLE", "Aperçu introuvable ou expiré");
      if (type === "a" && ext === ".jpg") {
        let img; try { img = fs.readFileSync(path.join(APERCUS_DIR, id + ".jpg")); } catch { throw new ErreurApp(404, "APERCU_INTROUVABLE", "Image introuvable"); }
        return { __brut: true, statut: 200, entetes: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" }, corps: img };
      }
      if (type === "a" && ext) {
        if (!meta.video || "." + meta.video !== ext) throw new ErreurApp(404, "APERCU_INTROUVABLE", "Vidéo introuvable");
        return servirFichier(req, path.join(APERCUS_DIR, id + ext), ext === ".mp4" ? "video/mp4" : "video/webm");
      }
      if (type === "a") return { __brut: true, statut: 200, entetes: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }, corps: pageApercu(id, meta) };
      // /w/<id> : la conversation WhatsApp, message prêt à envoyer
      const cible = `https://wa.me/${meta.numero}?text=${encodeURIComponent(meta.texte || "")}`;
      return { __brut: true, statut: 302, entetes: { Location: cible, "Cache-Control": "no-store" }, corps: "" };
    }
  }

  if (!configure()) throw new ErreurApp(503, "TYPO_CAO_NOT_CONFIGURED", "L'espace atelier n'est pas configuré");

  // balise de visite anonyme (envoyée par les pages du site)
  if (req.method === "POST" && chemin === "/api/typo-cao/visite") {
    res.statusCode = 202;
    if (!limiteDebit(`visite|${ip}`, 120, 60 * 60_000)) return { ok: true };
    const corps = await lireCorps(req, 2048).catch(() => ({}));
    const page = corps && corps.page === "atelier" ? "atelier" : "accueil";
    enregistrerVisite(page, ip, String(req.headers["user-agent"] || ""));
    return { ok: true };
  }

  // journal consultable dans l'espace atelier (session requise)
  if (req.method === "GET" && chemin === "/api/typo-cao/journal") {
    verifierSession(req.headers.authorization);
    const jours = Object.keys(journal.jours).sort().slice(-30).map(d => {
      const j = journal.jours[d];
      return {
        jour: d,
        visites: Object.values(j.pages).reduce((a, b) => a + b, 0),
        visiteurs: j.visiteurs.length,
        pages: j.pages,
        appareils: j.appareils,
      };
    });
    return { jours, connexions: journal.connexions.slice(-100).reverse(), persistant: journalPersistant };
  }

  if (req.method === "POST" && chemin === "/api/typo-cao/login") {
    if (!limiteDebit(`login|${ip}`, 5, 15 * 60_000))
      throw new ErreurApp(429, "TYPO_CAO_TOO_MANY_ATTEMPTS", "Trop de tentatives, réessaie dans quelques minutes");
    const { numero } = await lireCorps(req, 4096);
    const n = normaliserNumero(numero);
    const reponse = { codeEnvoye: true, expireDansSecondes: OTP_TTL_MS / 1000 };
    // réponse identique quel que soit le numéro : seuls les numéros de l'atelier reçoivent un code
    if (!n || !CFG.NUMEROS_AUTORISES.includes(n)) { enregistrerConnexion("numero_inconnu", ip, numero); return reponse; }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    otps.set(n, { codeSha256: sha256(code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
    await envoyerCodeWhatsApp(code, n);
    envoyerCodeTexte(code, n); // second canal, sans attendre
    enregistrerConnexion("code_envoye", ip, n);
    return reponse;
  }

  if (req.method === "POST" && chemin === "/api/typo-cao/verify") {
    const { numero, code } = await lireCorps(req, 4096);
    const n = normaliserNumero(numero);
    const otp = n ? otps.get(n) : null;
    if (!otp || !/^\d{6}$/.test(String(code || ""))) {
      enregistrerConnexion("code_errone", ip, numero);
      throw new ErreurApp(401, "TYPO_CAO_CODE_INVALID", "Code incorrect ou expiré");
    }
    if (Date.now() > otp.expiresAt) {
      otps.delete(n);
      enregistrerConnexion("code_expire", ip, n);
      throw new ErreurApp(401, "TYPO_CAO_CODE_EXPIRED", "Code expiré, reconnecte-toi");
    }
    otp.attempts += 1;
    if (otp.attempts > 5) {
      otps.delete(n);
      enregistrerConnexion("trop_essais", ip, n);
      throw new ErreurApp(429, "TYPO_CAO_TOO_MANY_ATTEMPTS", "Trop d'essais, reconnecte-toi");
    }
    const a = Buffer.from(otp.codeSha256, "hex"), b = Buffer.from(sha256(String(code)), "hex");
    if (!timingSafeEqual(a, b)) {
      enregistrerConnexion("code_errone", ip, n);
      throw new ErreurApp(401, "TYPO_CAO_CODE_INVALID", "Code incorrect ou expiré");
    }
    otps.delete(n);
    enregistrerConnexion("connexion_reussie", ip, n);
    return creerJeton();
  }

  if (req.method === "POST" && chemin === "/api/typo-cao/avis") {
    if (!limiteDebit(`avis|${ip}`, 3, 60 * 60_000))
      throw new ErreurApp(429, "TYPO_CAO_AVIS_RATE_LIMITED", "Trop d'avis envoyés, réessaie plus tard");
    const corps = await lireCorps(req, 8192);
    const nom = String(corps.nom || "").trim();
    const note = Number(corps.note);
    const message = String(corps.message || "").trim();
    if (nom.length < 2 || nom.length > 40 || !Number.isInteger(note) || note < 1 || note > 5 || message.length < 5 || message.length > 400)
      throw new ErreurApp(400, "AVIS_INVALIDE", "Avis incomplet ou invalide");
    const f = await ghLire("avis.json", CFG.BRANCHES[0]);
    let liste = [];
    if (f) { try { liste = JSON.parse(Buffer.from(f.content, "base64").toString("utf8")); } catch {} }
    if (!Array.isArray(liste)) liste = [];
    liste.push({ id: randomUUID(), nom, note, message, date: new Date().toISOString(), approuve: false });
    await ghEcrire("avis.json", Buffer.from(JSON.stringify(liste.slice(-500), null, 2)).toString("base64"), "Nouvel avis client (en attente de validation)");
    res.statusCode = 201;
    return { merci: true };
  }

  if (chemin === "/api/typo-cao/file") {
    verifierSession(req.headers.authorization);
    if (req.method === "GET") {
      const path = url.searchParams.get("path");
      if (!cheminValide(path)) throw new ErreurApp(400, "CHEMIN_INVALIDE", "Chemin de fichier invalide");
      const f = await ghLire(path, CFG.BRANCHES[0]);
      if (!f) throw new ErreurApp(404, "TYPO_CAO_FILE_NOT_FOUND", "Fichier introuvable");
      return { path, contentB64: String(f.content || "").replace(/\n/g, "") };
    }
    if (req.method === "PUT") {
      const { path, contentB64, message } = await lireCorps(req);
      if (!cheminValide(path)) throw new ErreurApp(400, "CHEMIN_INVALIDE", "Chemin de fichier invalide");
      if (typeof contentB64 !== "string" || !contentB64 || contentB64.length > 950_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentB64))
        throw new ErreurApp(400, "CONTENU_INVALIDE", "Contenu invalide");
      const msg = String(message || "Mise à jour via l'espace atelier").slice(0, 200);
      await ghEcrire(path, contentB64, msg);
      return { enregistre: true, branches: CFG.BRANCHES };
    }
  }

  throw new ErreurApp(404, "NOT_FOUND", "Route inconnue");
}

/* ---------- serveur HTTP + CORS ---------- */
const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const origine = req.headers.origin || "";
  if (origine === CFG.ORIGINE_AUTORISEE) {
    res.setHeader("Access-Control-Allow-Origin", origine);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  // écritures : uniquement depuis l'origine autorisée (ou sans origine, ex. curl)
  if (req.method !== "GET" && origine && origine !== CFG.ORIGINE_AUTORISEE) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Origine non autorisée" } }));
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "inconnu").trim();
  try {
    const resultat = await router(req, res, url, ip);
    if (resultat && resultat.__brut) {
      res.statusCode = resultat.statut;
      for (const [k, v] of Object.entries(resultat.entetes)) res.setHeader(k, v);
      if (resultat.corps && typeof resultat.corps.pipe === "function") return resultat.corps.pipe(res);
      return res.end(resultat.corps);
    }
    res.end(JSON.stringify(resultat));
  } catch (e) {
    const statut = e instanceof ErreurApp ? e.statut : 500;
    const code = e instanceof ErreurApp ? e.code : "INTERNAL";
    if (statut === 500) console.error("Erreur interne :", e);
    res.statusCode = statut;
    res.end(JSON.stringify({ error: { code, message: e instanceof ErreurApp ? e.message : "Erreur interne" } }));
  }
});

serveur.listen(CFG.PORT, () => {
  console.log(`Serveur Typo Cao démarré sur le port ${CFG.PORT} — configuré : ${configure()}`);
});
