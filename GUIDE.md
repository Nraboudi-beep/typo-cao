# Guide Typo Cao — gérer le site soi-même

## ⭐ Le plus simple : ton espace atelier

Ton site a une page d'administration rien que pour toi :

**https://nraboudi-beep.github.io/typo-cao/admin.html**

1. Ouvre cette adresse (mets-la en favori)
2. Entre ton **numéro WhatsApp**, puis le **code à 6 chiffres reçu sur WhatsApp** — pas de mot de passe, et ta connexion reste mémorisée 24 h sur ton appareil
3. Tu peux alors, visuellement, sans aucun code :
   - ajouter / modifier / retirer **tes tarifs**
   - changer ton **WhatsApp** et ton **Instagram**
   - ajouter une **matière** à la galerie (l'image est automatiquement recadrée, réduite et filigranée)
   - mettre en ligne une **nouvelle collection complète** : tu sélectionnes tes 26 images (nommées A.png, B.png, … Z.png), la page les recadre, les réduit, applique le filigrane « TYPO CAO » et les met en ligne une par une
4. **Modérer tes avis clients** : les avis laissés sur le site arrivent dans la section « Avis clients » de ton espace — tu choisis ceux que tu publies (bouton Publier/Masquer), tu supprimes les indésirables, puis « Enregistrer les avis ». Rien ne s'affiche sur le site sans ta validation.
5. Termine toujours par le bouton **« Enregistrer les modifications »** — le site public se met à jour en 1 à 2 minutes

### Ta protection

- Le site affiche « © Yuan Cao — Tous droits réservés » et une page **mentions** qui rappelle que tes créations sont protégées par le droit d'auteur (c'est automatique en France dès la création, articles L.111-1 et suivants du CPI — pas besoin de dépôt pour être protégée).
- Pour pouvoir **prouver la date** de tes créations en cas de litige : garde tes fichiers originaux datés, et envisage une **enveloppe Soleau** à l'INPI (~15 €, en ligne sur inpi.fr) pour tes collections importantes.
- Ne mets jamais tes images pleine qualité en ligne : le site ne montre que des aperçus filigranés.

⚠️ Si tu reçois un code de connexion WhatsApp sans l'avoir demandé, ignore-le et préviens Nizar : quelqu'un essaie d'entrer. Ne transmets jamais un code reçu, à personne.

### Pour Nizar : côté serveur

La connexion et les enregistrements passent par un **service autonome** : le dossier `serveur/` de ce dépôt (un seul conteneur Docker, indépendant de tout autre projet, qui réutilise uniquement le moteur WhatsApp Meta existant). Le jeton GitHub reste dans les variables d'environnement de ce service. Installation complète : `serveur/README-serveur.md`. Tant que le service n'est pas en ligne, la page bascule automatiquement sur l'ancienne connexion par clé GitHub.

---

## Méthode avancée (sans l'espace atelier)

Tout ce que fait l'espace atelier peut aussi se faire à la main dans le fichier **`config.json`** du dépôt GitHub, comme décrit ci-dessous. Chaque modification met le site à jour automatiquement en 1 à 2 minutes.

Tout se passe dans **un seul fichier : `config.json`**. Pour le modifier : ouvre le fichier sur GitHub → clique sur le crayon ✏️ (Edit) → fais ta modification → bouton vert **Commit changes**.

⚠️ Règles d'or du fichier : chaque texte entre `"guillemets"`, une virgule entre chaque élément mais **pas après le dernier**. En cas de doute, copie un bloc existant et modifie-le.

---

## 1. Ajouter mes tarifs

Remplace `"tarifs": []` par tes formules :

```json
"tarifs": [
  { "nom": "Prénom simple", "prix": "15 €", "detail": "jusqu'à 8 lettres, 1 vidéo" },
  { "nom": "Message complet", "prix": "25 €", "detail": "jusqu'à 30 lettres" },
  { "nom": "Sur mesure", "prix": "sur devis", "detail": "matières spéciales, longue vidéo" }
]
```

Les formules apparaissent dans le formulaire de demande ; le choix du client arrive dans ton message WhatsApp. Pour masquer les tarifs, remets `"tarifs": []`.

## 2. Ajouter une nouvelle collection de typos

Exemple : une collection « Roses » générée avec ChatGPT.

1. Prépare tes 26 images (A à Z), fond transparent, et nomme-les **exactement** : `roses_A.webp`, `roses_B.webp`, … `roses_Z.webp` (préfixe en minuscules, lettre en majuscule). Si tes images sont en PNG, convertis-les en WebP (convertio.co fait ça gratuitement) et réduis-les à ~300 px de haut.
2. Sur GitHub, ouvre le dossier `assets` → **Add file → Upload files** → dépose les 26 images → Commit.
3. Dans `config.json`, ajoute ta collection à la liste :

```json
"collections": [
  { "id": "perles", "label": "Perles & Or" },
  { "id": "football", "label": "Football" },
  { "id": "roses", "label": "Roses" }
]
```

Le `id` doit être identique au préfixe des fichiers (`roses` → `roses_A.webp`).

💡 **Important — protège tes créations** : ne mets jamais tes images originales en pleine qualité dans le dépôt, il est public. Mets en ligne des versions réduites (~300 px) et idéalement filigranées. Tes originaux restent chez toi ; c'est eux que tu utilises pour les montages livrés aux clients.

## 3. Ajouter une matière à la galerie

Dépose l'image dans `assets` (même conseil : petite taille, filigrane), puis ajoute une ligne :

```json
{ "fichier": "ma_nouvelle_matiere.webp", "nom": "Velours bleu nuit" }
```

## 4. Changer mes contacts

- **WhatsApp** (où arrivent les commandes) : `"whatsapp": "33665433314"` — format international sans le `+` ni espaces.
- **Instagram** : `"instagram": "ton_pseudo"` — le lien apparaît en bas du site. Vide (`""`) = pas de lien.

---

## Comment ça marche (pour mémoire)

- Le site est hébergé gratuitement par GitHub Pages : https://nraboudi-beep.github.io/typo-cao/
- `index.html` est l'application — ne pas y toucher, tout se règle dans `config.json`.
- Les aperçus montrés aux clients sont en basse résolution et filigranés « TYPO CAO » : la vidéo téléchargée sur le site est un aperçu ; la version finale propre, c'est toi qui la livres après la commande.
