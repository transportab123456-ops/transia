# Déploiement — Transia

## Identité Git obligatoire

Vercel refuse tout déploiement dont l'auteur du commit n'est pas membre de
l'équipe du projet. Le refus est explicite :

```
The deployment was blocked because the commit author doesn't have permission
to create deployments for this project.   (TEAM_ACCESS_REQUIRED)
```

L'équipe `transportab123456-ops` est en plan **Hobby** : un seul membre, le
compte `transportab123456-ops`. Tout commit doit donc être signé par :

```
transportab123456-ops <transportab123456@gmail.com>
```

Réglage, à faire **une fois par machine** (il couvre tous les clones) :

```bash
git config --global user.name  "transportab123456-ops"
git config --global user.email "transportab123456@gmail.com"
```

Vérification avant de pousser :

```bash
git log -1 --format='%an <%ae>'
# attendu : transportab123456-ops <transportab123456@gmail.com>
```

Si un poste affiche l'ancienne identité (`alainbibas-creator`), appliquer les
deux commandes ci-dessus, puis créer le commit suivant : un commit déjà poussé
avec la mauvaise identité exigerait un `push --force` pour être corrigé, ce qui
n'est pas nécessaire.

## Garde-fou automatique

Trois hooks versionnés dans `.githooks/` refusent le travail avant que Vercel
ne le bloque :

- `pre-commit` vérifie l'identité enregistrée dans un commit ordinaire ;
- `pre-merge-commit` fait de même pour un commit de fusion, que git ne fait pas
  passer par `pre-commit` ;
- `pre-push` vérifie tous les commits réellement poussés : filet de sécurité si
  un commit a été créé hors de ces chemins, ou avec `--no-verify`.

L'activation est **automatique** : `npm install` et `npm ci` lancent le script
`postinstall` `install-git-hooks.js`, qui pose `core.hooksPath=.githooks` pour le
clone courant. Sans dépôt Git (build Vercel, archive), il ne fait rien et ne fait
jamais échouer l'installation.

Pour l'activer sans passer par npm :

```bash
git config core.hooksPath .githooks
```

`git commit --no-verify` et `git push --no-verify` contournent les hooks : à
éviter, le déploiement serait bloqué côté Vercel.

Un rebase ne passe pas par `pre-commit` (git ne l'exécute pas) et conserve
l'auteur d'origine : c'est `pre-push` qui refuse alors les anciens commits
réattribués, en indiquant comment corriger un seul commit ou toute une série.

## Ce que fait un push sur `main`

1. le workflow **Tests** exécute `npm test` (14 suites, base PostgreSQL jetable) ;
2. Vercel déploie la production et réattribue `https://transia-sooty.vercel.app`.

Un déploiement bloqué ne peut pas être relancé : il faut corriger l'identité
puis pousser un nouveau commit.

## Déploiement manuel (secours)

Avec le compte propriétaire authentifié (`vercel login`) :

```bash
vercel --prod
```

Si la CLI est elle aussi bloquée pour cause d'auteur, déployer l'arbre du
commit sans métadonnées Git :

```bash
T=$(mktemp -d)
git archive <sha> | tar -x -C "$T"
mkdir -p "$T/.vercel" && cp .vercel/project.json "$T/.vercel/"
vercel --prod --cwd "$T"
```

Ce déploiement fonctionne mais n'est pas rattaché au commit dans le tableau
Vercel : préférer le push dès que l'identité est correcte.

## Fichiers jamais publiés

`.vercelignore` exclut `.env`/`.env.*`, `db/`, `test/`, `tools/`, `.specs/`,
`node_modules/`, `.git/`, `.vercel/`, `.cloud-attachments/` et `*.md`.
