"use strict";
/* Courrier — l'onglet de l'atelier.
   La personne est déjà connectée à son atelier : on demande au serveur un
   laissez-passer, on le présente au service de courrier, et la boîte s'ouvre.
   Aucun mot de passe de messagerie ne passe par ici.

   Règle tenue de bout en bout : le service propose, la personne dispose.
   Rien ne part sans un clic sur « Envoyer la réponse », et le texte des
   messages reçus est affiché, jamais interprété. */
(function(){

let BASE = "", JETON = "", MOI = null;
let MESSAGES = [], COURANT = null, FILTRE = "tous", RELEVE = {}, MONTEE = false;
let T = null, LANGUE = () => "fr", APPEL_ATELIER = null;

const $ = id => document.getElementById(id);
const ech = s => String(s == null ? "" : s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

async function api(route, options = {}){
  const r = await fetch(BASE + "/api" + route, {
    ...options,
    headers: { "Content-Type": "application/json",
      ...(JETON ? { Authorization: "Bearer " + JETON } : {}), ...(options.headers || {}) }
  }).catch(() => null);
  if (!r) throw new Error(T("cr.erreur"));
  if (r.status === 401 && JETON) { JETON = ""; await entrer(); return api(route, options); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erreur || "erreur " + r.status);
  return d;
}

/* ---------- entrée sans seconde connexion ---------- */
async function entrer(){
  const p = await APPEL_ATELIER("/courrier-pass");
  BASE = String(p.url || BASE).replace(/\/+$/, "");
  const r = await fetch(BASE + "/api/entree-atelier", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pass: p.pass })
  }).catch(() => null);
  if (!r) throw new Error(T("cr.erreur"));
  const d = await r.json().catch(() => ({}));
  if (r.status === 404) throw new Error(T("cr.sansBoite"));
  if (!r.ok) throw new Error(d.erreur || T("cr.erreur"));
  JETON = d.jeton; MOI = d;
}

/* ---------- affichage ---------- */
function quand(iso){
  const d = new Date(iso), loc = T("gen.locale");
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(loc, { day: "numeric", month: "short" });
}

function squelette(racine){
  racine.innerHTML = `
  <section class="co">
    <h2 data-i18n="cr.titre"></h2>
    <p class="hint" id="coAide"></p>
    <div class="co-plan" id="coPlan">
      <div class="co-liste">
        <div class="co-barre">
          <button type="button" class="ghost small" id="coRelever"></button>
          <button type="button" class="quiet small" id="coFiltre"></button>
          <span class="co-cpt" id="coCpt"></span>
        </div>
        <div class="co-fil" id="coFil"></div>
      </div>
      <div class="co-lecture">
        <div class="co-rien" id="coRien"></div>
        <div class="co-vue" id="coVue">
          <div class="co-entete">
            <button type="button" class="quiet small co-retour" id="coRetour">‹ <span id="coRetourT"></span></button>
            <h3 id="coObjet"></h3>
            <div class="co-meta" id="coMeta"></div>
          </div>
          <div class="co-corps" id="coCorps"></div>
          <div class="co-barre-rep"><button type="button" id="coOuvrirRep"></button></div>
          <div class="co-reponse" id="coReponse">
            <button type="button" class="quiet small co-retour-rep" id="coRetourRep">‹ <span id="coRetourRepT"></span></button>
            <div class="co-mods" id="coMods"></div>
            <textarea id="coBrouillon" spellcheck="true"></textarea>
            <div class="co-pied">
              <span class="co-reste" id="coReste"></span>
              <span class="co-parti" id="coParti" hidden>✓ <span id="coPartiT"></span></span>
              <span class="co-actions">
                <button type="button" class="quiet" id="coArchiver"></button>
                <button type="button" id="coEnvoyer"></button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

function textes(){
  $("coAide").innerHTML = T("cr.aide", { adresse: ech(MOI ? MOI.adresse : "") });
  $("coRelever").textContent = T("cr.relever");
  $("coFiltre").textContent = FILTRE === "neufs" ? T("cr.aTraiter") : T("cr.tous");
  $("coRien").textContent = T("cr.rien");
  $("coRetourT").textContent = T("cr.retour");
  $("coRetourRepT").textContent = T("cr.leMessage");
  $("coOuvrirRep").textContent = T("cr.repondre");
  $("coEnvoyer").textContent = T("cr.envoyer");
  $("coArchiver").textContent = (COURANT && COURANT.archive) ? T("cr.desarchiver") : T("cr.archiver");
  $("coPartiT").textContent = T("cr.parti");
  const h2 = document.querySelector(".co h2"); if (h2) h2.textContent = T("cr.titre");
}

function dessinerListe(){
  const liste = FILTRE === "neufs" ? MESSAGES.filter(m => !m.repondu && !m.archive) : MESSAGES;
  $("coCpt").textContent =
    (FILTRE === "neufs" ? T("cr.nTraiter", { n: liste.length }) : T("cr.compte", { n: liste.length }))
    + " · " + (RELEVE.derniere ? T("cr.releve", { h: quand(RELEVE.derniere) }) : T("cr.jamais"));
  if (!liste.length){
    $("coFil").innerHTML = '<div class="co-vide">' + ech(FILTRE === "neufs" ? T("cr.videFiltre") : T("cr.vide")) + "</div>";
    return;
  }
  $("coFil").innerHTML = liste.map(m => {
    const g = m.genre && m.genre !== "general" ? T("cr.g." + m.genre) : "";
    return '<button type="button" class="co-msg' + (m.lu ? "" : " neuf") + (m.repondu || m.archive ? " fait" : "")
      + (COURANT && COURANT.uid === m.uid ? " on" : "") + '" data-uid="' + ech(m.uid) + '">'
      + '<span class="l1"><span class="de">' + ech(m.de.nom || m.de.adresse) + "</span>"
      + (g ? '<span class="co-etiq">' + ech(g) + "</span>" : "")
      + '<span class="quand">' + quand(m.date) + "</span></span>"
      + '<span class="objet">' + ech(m.objet) + "</span>"
      + '<span class="extrait">' + ech(m.extrait) + "</span></button>";
  }).join("");
}

async function charger(){
  const d = await api("/messages");
  MESSAGES = d.messages || []; RELEVE = d.releve || {};
  dessinerListe();
}

async function afficher(uid, garderTexte){
  const d = await api("/message/" + encodeURIComponent(uid) + "?langue=" + LANGUE());
  COURANT = d.message;
  const m = MESSAGES.find(x => x.uid === String(uid)); if (m) m.lu = true;
  $("coRien").hidden = true;
  $("coVue").classList.add("on");
  $("coPlan").classList.add("lit");
  if (!garderTexte) $("coPlan").classList.remove("repond");
  $("coObjet").textContent = COURANT.objet;
  $("coMeta").innerHTML = T("cr.de") + " <b>" + ech(COURANT.de.nom || COURANT.de.adresse) + "</b>"
    + (COURANT.de.nom ? " &lt;" + ech(COURANT.de.adresse) + "&gt;" : "")
    + " · " + ech(new Date(COURANT.date).toLocaleString(T("gen.locale"), { dateStyle: "long", timeStyle: "short" }));
  // texte affiché tel quel : jamais interprété, jamais exécuté
  $("coCorps").textContent = COURANT.texte || "";
  if (COURANT.pieces && COURANT.pieces.length){
    const pj = document.createElement("div");
    pj.className = "co-pj";
    pj.innerHTML = "<span>" + T("cr.pieces") + " :</span>" + COURANT.pieces.map(x => "<span>" + ech(x.nom) + "</span>").join("");
    $("coCorps").appendChild(pj);
  }
  $("coArchiver").textContent = COURANT.archive ? T("cr.desarchiver") : T("cr.archiver");
  $("coParti").hidden = true;
  dessinerModeles(d.modeles, d.genre);
  if (!garderTexte){ $("coBrouillon").value = ""; majReste(); }
  dessinerListe();
}

function dessinerModeles(liste, genre){
  const barre = $("coMods");
  barre.innerHTML = '<span class="t">' + T("cr.modeles") + "</span>";
  for (const m of liste){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "co-mod" + (m.genre === genre && m.genre !== "general" ? " sug" : "");
    b.textContent = m.nom;
    b.onclick = () => {
      barre.querySelectorAll(".co-mod").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      const z = $("coBrouillon");
      z.value = m.texte + (MOI && MOI.nom ? "\n" + MOI.nom : "");
      majReste();
      const i = z.value.indexOf("[");
      z.focus();
      if (i >= 0) z.setSelectionRange(i, z.value.indexOf("]", i) + 1);
    };
    barre.appendChild(b);
  }
}

/* tant qu'il reste un [passage entre crochets], l'envoi est éteint */
function majReste(){
  const v = $("coBrouillon").value;
  const n = (v.match(/\[[^\]\n]{0,120}\]/g) || []).length;
  const r = $("coReste"), b = $("coEnvoyer");
  if (!v.trim()){ r.textContent = T("cr.ecrire"); r.classList.remove("ok"); b.disabled = true; return; }
  if (n){ r.textContent = T("cr.reste", { n }); r.classList.remove("ok"); b.disabled = true; return; }
  r.textContent = T("cr.pret"); r.classList.add("ok"); b.disabled = false;
}

async function envoyer(){
  if (!COURANT) return;
  $("coEnvoyer").disabled = true;
  try {
    await api("/repondre", { method: "POST", body: JSON.stringify({ uid: COURANT.uid, texte: $("coBrouillon").value }) });
    const m = MESSAGES.find(x => x.uid === COURANT.uid); if (m) m.repondu = true;
    COURANT.repondu = true;
    $("coParti").hidden = false;
    $("coBrouillon").value = ""; majReste();
    dessinerListe();
  } catch (e) {
    $("coReste").textContent = e.message; $("coReste").classList.remove("ok"); $("coEnvoyer").disabled = false;
  }
}

async function brancher(){
  $("coFil").onclick = e => { const b = e.target.closest(".co-msg"); if (b) afficher(b.dataset.uid).catch(err => console.error(err.message)); };
  $("coRetour").onclick = () => $("coPlan").classList.remove("lit", "repond");
  $("coRetourRep").onclick = () => $("coPlan").classList.remove("repond");
  $("coOuvrirRep").onclick = () => { $("coPlan").classList.add("repond"); $("coBrouillon").focus(); };
  $("coBrouillon").oninput = majReste;
  $("coEnvoyer").onclick = envoyer;
  $("coArchiver").onclick = async () => {
    if (!COURANT) return;
    const etat = !COURANT.archive;
    try { await api("/archiver", { method: "POST", body: JSON.stringify({ uid: COURANT.uid, archive: etat }) }); }
    catch (e) { return console.error(e.message); }
    COURANT.archive = etat;
    const m = MESSAGES.find(x => x.uid === COURANT.uid); if (m) m.archive = etat;
    $("coArchiver").textContent = etat ? T("cr.desarchiver") : T("cr.archiver");
    dessinerListe();
  };
  $("coFiltre").onclick = () => {
    FILTRE = FILTRE === "tous" ? "neufs" : "tous";
    $("coFiltre").textContent = FILTRE === "neufs" ? T("cr.aTraiter") : T("cr.tous");
    dessinerListe();
  };
  $("coRelever").onclick = async () => {
    $("coRelever").disabled = true;
    try { RELEVE = await api("/relever", { method: "POST" }); await charger(); }
    catch (e) { console.error(e.message); }
    finally { $("coRelever").disabled = false; }
  };
}

window.CourrierAtelier = {
  /* Appelé à chaque ouverture de l'onglet. Monte la vue une fois, puis
     se contente de rafraîchir. */
  async ouvrir({ racine, t, langue, apiAtelier, base }){
    T = t; LANGUE = langue; APPEL_ATELIER = apiAtelier;
    if (base) BASE = String(base).replace(/\/+$/, "");
    if (!MONTEE){
      squelette(racine);
      try { await entrer(); } catch (e) {
        racine.innerHTML = '<section class="co"><h2></h2><p class="hint"></p></section>';
        racine.querySelector("h2").textContent = t("co.titre");
        racine.querySelector(".hint").textContent = e.message;
        return;
      }
      textes(); await brancher();
      MONTEE = true;
    }
    textes();
    // en revenant sur l'onglet, on repart de la liste : sur écran étroit,
    // rester sur un ancien message donnerait l'impression d'une boîte vide
    const plan = $("coPlan"); if (plan) plan.classList.remove("lit", "repond");
    try { await charger(); } catch (e) { console.error(e.message); }
    api("/relever", { method: "POST" }).then(r => { RELEVE = r; return charger(); }).catch(() => {});
  },
  /* rejoué quand on change la langue de l'atelier */
  retraduire(){
    if (!MONTEE) return;
    textes(); dessinerListe();
    if (COURANT) afficher(COURANT.uid, true).catch(() => {});
  }
};
})();
