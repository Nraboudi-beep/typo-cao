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

/* ---------- routes ---------- */
async function router(req, res, url, ip) {
  const chemin = url.pathname.replace(/\/+$/, "");

  if (req.method === "GET" && chemin === "/api/typo-cao/status") {
    return { configure: configure() };
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
