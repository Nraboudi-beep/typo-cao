# Typo Cao

Catalogue interactif de lettres 3D et moteur de rendu vidéo — l'atelier de Yuan Cao.

Le client compose son prénom ou un message, choisit une collection de lettres (Perles & Or, Football) et une animation (Pop, Chute, Fondu), explore les matières disponibles, importe sa vidéo et obtient un aperçu rendu directement dans son navigateur (lettres animées incrustées, son conservé). Il télécharge l'aperçu filigrané et envoie sa commande sur WhatsApp ; la version finale sans filigrane est livrée par l'atelier.

## Contenu

- `index.html` — toute l'application (une seule page, aucun serveur requis)
- `assets/` — les lettres en WebP (aperçus 300 px, filigranés TYPO CAO)

## Hébergement

N'importe quel hébergement statique convient (GitHub Pages, Netlify...). Pour GitHub Pages : Settings → Pages → Branch `main` → dossier `/ (root)`.

Les originaux pleine résolution ne sont pas dans ce dépôt : seuls les aperçus filigranés sont publiés.

## Configuration

Dans `index.html` : `CONFIG.whatsapp` (numéro de réception des commandes, format international sans +).
