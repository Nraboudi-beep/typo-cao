# Serveur Typo Cao — service autonome

Petit service indépendant (un seul conteneur Docker, zéro dépendance npm) pour l'espace atelier de Yuan : connexion par numéro WhatsApp + code, proxy GitHub, réception des avis clients. **Il ne touche à aucun autre projet** : il s'attache seulement au moteur WhatsApp (les mêmes identifiants Meta que le serveur existant).

## Installation sur le VPS

```bash
# 1. Récupérer ce dossier sur le serveur
sudo mkdir -p /opt/typo-cao && sudo chown $USER /opt/typo-cao
cd /opt/typo-cao
git clone --depth 1 https://github.com/Nraboudi-beep/typo-cao.git tmp \
  && mv tmp/serveur/* . && rm -rf tmp

# 2. Configurer
cp .env.example .env
nano .env   # remplir les valeurs (voir commentaires du fichier)
# Les 3 valeurs WHATSAPP_* : recopier celles du .env existant du moteur WhatsApp.

# 3. Démarrer
docker compose up -d --build

# 4. Tester en local
curl http://127.0.0.1:8787/api/typo-cao/status
# attendu : {"configure":true}
```

## Exposer en HTTPS (une seule ligne d'infra)

Le service écoute sur `127.0.0.1:8787`. Il faut le publier en HTTPS sur un sous-domaine, par exemple **typo.atelierdedemain.fr** :

1. DNS : ajouter un enregistrement A `typo.atelierdedemain.fr` → IP du VPS
2. Dans la configuration Caddy existante, ajouter le bloc :

```
typo.atelierdedemain.fr {
    reverse_proxy 127.0.0.1:8787
}
```

puis recharger Caddy (`docker exec atelier-caddy-1 caddy reload --config /etc/caddy/Caddyfile` ou redémarrer le conteneur caddy). Caddy obtient le certificat HTTPS tout seul.

3. Test final : `curl https://typo.atelierdedemain.fr/api/typo-cao/status` → `{"configure":true}`

> Si le sous-domaine choisi n'est pas `typo.atelierdedemain.fr`, changer la constante `ATELIER_API` en haut du script de `admin.html` et de `index.html` du site.

## Prérequis côté Meta

Un template WhatsApp **`typo_cao_code`** (catégorie *Authentification*, langue *fr*, bouton « Copier le code », expiration 5 min) doit exister et être approuvé dans le WhatsApp Manager du compte.

## Points de terminaison

- `GET  /api/typo-cao/status` — état de configuration
- `POST /api/typo-cao/login {numero}` — envoie un code (uniquement au numéro configuré ; réponse identique pour tout autre numéro)
- `POST /api/typo-cao/verify {numero, code}` — renvoie un jeton de session (24 h)
- `POST /api/typo-cao/avis {nom, note, message}` — dépôt d'avis (3/h/IP, en attente de validation)
- `GET/PUT /api/typo-cao/file` — lecture/écriture du dépôt du catalogue (session requise)
