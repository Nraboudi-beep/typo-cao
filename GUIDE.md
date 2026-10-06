# Guide Typo Cao — gérer le site soi-même

Ce guide explique comment ajouter **tes tarifs**, **tes nouvelles collections de typos** et **tes matières**, directement depuis le site GitHub, sans rien installer. Chaque modification met le site à jour automatiquement en 1 à 2 minutes.

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
