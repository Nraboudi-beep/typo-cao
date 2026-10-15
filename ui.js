/* Typo Cao — habillage des champs « fichier ».
   Le contrôle natif n'a ni la même forme ni le même texte d'un navigateur à
   l'autre : on le masque (il reste là, et fonctionne) et on affiche à sa place
   un bouton de la même famille que les autres, suivi du nom du fichier choisi.
   Appeler habillerFichiers() après chaque changement de langue. */
window.habillerFichiers = function(txt){
  const choisir = (txt && txt.choisir) || "Choisir un fichier";
  const aucun = (txt && txt.aucun) || "Aucun fichier choisi";
  for (const input of document.querySelectorAll('input[type="file"]')){
    if (input.hidden || input.dataset.brut === "1") continue;      // champ piloté par un bouton à part
    let hote = input.closest(".fichier");
    if (!hote){
      hote = document.createElement("span");
      hote.className = "fichier";
      input.parentNode.insertBefore(hote, input);
      hote.appendChild(input);
      const id = input.id || ("f" + Math.random().toString(36).slice(2, 8));
      input.id = id;
      const bouton = document.createElement("label");
      bouton.className = "fichier-btn";
      bouton.setAttribute("for", id);
      const nom = document.createElement("span");
      nom.className = "fichier-nom";
      hote.append(bouton, nom);
      input.addEventListener("change", () => majNom(hote));
    }
    hote.querySelector(".fichier-btn").textContent = choisir;
    hote.dataset.aucun = aucun;
    majNom(hote);
  }
  function majNom(hote){
    const input = hote.querySelector('input[type="file"]');
    const n = input.files ? input.files.length : 0;
    hote.querySelector(".fichier-nom").textContent =
      n === 0 ? hote.dataset.aucun : n === 1 ? input.files[0].name : n + " fichiers";
  }
};
