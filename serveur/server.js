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
const { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } = require("node:crypto");

/* ---------- configuration (variables d'environnement) ---------- */
const CFG = {
  PORT: Number(process.env.PORT || 8787),
  ORIGINE_AUTORISEE: process.env.TYPO_CAO_ORIGINE || "https://nraboudi-beep.github.io",
  WHATSAPP_TO: process.env.TYPO_CAO_WHATSAPP_TO || "",
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
};

const configure = () =>
  Boolean(CFG.WHATSAPP_TO && CFG.GITHUB_TOKEN && CFG.SESSION_SECRET && CFG.WA_TOKEN && CFG.WA_PHONE_ID);

/* ---------- petits utilitaires ---------- */
const sha256 = v => createHash("sha256").update(v).digest("hex");
const OTP_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 24 * 60 * 60_000;
let otp = null; // { codeSha256, expiresAt, attempts }
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

class ErreurApp extends Error {
  constructor(statut, code, message) {
    super(message);
    this.statut = statut;
    this.code = code;
  }
}

/* ---------- moteur WhatsApp (API Meta Cloud) ---------- */
async function envoyerCodeWhatsApp(code) {
  const r = await fetch(`https://graph.facebook.com/${CFG.WA_API}/${CFG.WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CFG.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: CFG.WHATSAPP_TO.slice(1), // E.164 sans le « + »
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

  if (req.method === "POST" && chemin === "/api/typo-cao/login") {
    if (!limiteDebit(`login|${ip}`, 5, 15 * 60_000))
      throw new ErreurApp(429, "TYPO_CAO_TOO_MANY_ATTEMPTS", "Trop de tentatives, réessaie dans quelques minutes");
    const { numero } = await lireCorps(req, 4096);
    const n = normaliserNumero(numero);
    const reponse = { codeEnvoye: true, expireDansSecondes: OTP_TTL_MS / 1000 };
    // réponse identique quel que soit le numéro : seul celui de l'atelier reçoit un code
    if (!n || n !== CFG.WHATSAPP_TO) return reponse;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    otp = { codeSha256: sha256(code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 };
    await envoyerCodeWhatsApp(code);
    return reponse;
  }

  if (req.method === "POST" && chemin === "/api/typo-cao/verify") {
    const { numero, code } = await lireCorps(req, 4096);
    const n = normaliserNumero(numero);
    if (!otp || !n || n !== CFG.WHATSAPP_TO || !/^\d{6}$/.test(String(code || "")))
      throw new ErreurApp(401, "TYPO_CAO_CODE_INVALID", "Code incorrect ou expiré");
    if (Date.now() > otp.expiresAt) { otp = null; throw new ErreurApp(401, "TYPO_CAO_CODE_EXPIRED", "Code expiré, reconnecte-toi"); }
    otp.attempts += 1;
    if (otp.attempts > 5) { otp = null; throw new ErreurApp(429, "TYPO_CAO_TOO_MANY_ATTEMPTS", "Trop d'essais, reconnecte-toi"); }
    const a = Buffer.from(otp.codeSha256, "hex"), b = Buffer.from(sha256(String(code)), "hex");
    if (!timingSafeEqual(a, b)) throw new ErreurApp(401, "TYPO_CAO_CODE_INVALID", "Code incorrect ou expiré");
    otp = null;
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
