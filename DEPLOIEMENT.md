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

`git commit --no-verify` et `git push --no-verify` contournent les hooks : le
contrôle en CI les rattrape, et il bloque désormais la fusion (voir ci-dessous).

Un rebase ne passe pas par `pre-commit` (git ne l'exécute pas) et conserve
l'auteur d'origine : c'est `pre-push` qui refuse alors les anciens commits
réattribués, en indiquant comment corriger un seul commit ou toute une série.

## Contrôle en CI (bloquant)

`--no-verify` contourne les hooks locaux : le workflow **Auteur des commits**
(`.github/workflows/auteur.yml`) rejoue le contrôle, et le dépôt est réglé pour
que ce check bloque réellement `main`.

- déclencheurs : chaque push vers `main`, et chaque pull request vers `main` ;
- portée en pull request : `base.sha..head.sha` de la PR — le commit de fusion
  construit par GitHub n'est pas jugé, seuls les commits de la branche le sont ;
- portée en push : `github.event.before..github.event.after`, c'est-à-dire
  exactement les commits du push ; premier push ou `before` introuvable
  (force-push) : seul le commit de tête est vérifié, l'historique antérieur à la
  règle n'est pas jugé ;
- clone complet (`fetch-depth: 0`), sinon le commit d'avant le push est absent ;
- échec : une ligne `::error::` par commit fautif, plus un récapitulatif dans le
  résumé du run avec les commandes de correction ;
- succès : `N commit(s) vérifié(s), 0 non conforme(s).`

Le ruleset **main - PR obligatoire et checks auteur/test** (actif, sur
`refs/heads/main`) exige une pull request et les checks `auteur` et `test`, sans
acteur de contournement ; force-push et suppression de `main` sont bloqués. Un
push direct est refusé par le serveur (`GH013`), et une PR dont le check
`auteur` échoue reste `BLOCKED` : la fusion est refusée même pour le
propriétaire, sauf `--admin` (à éviter).

Un ruleset n'existe que sur un dépôt public ou avec GitHub Pro : le dépôt est
donc **public** depuis le 2026-11-23. Aucun secret n'est versionné — seuls
`.env.example` et `.env.admin.example` le sont, avec des valeurs fictives.

Une fusion de pull request depuis l'interface GitHub crée un commit dont l'auteur
est le compte qui fusionne : si ce compte n'est pas `transportab123456-ops`, le
contrôle échoue — et Vercel aurait bloqué le déploiement de la même façon.

## Ce que fait une fusion sur `main`

1. la PR ne peut être fusionnée que si les checks `auteur` et `test` sont verts ;
2. le workflow **Auteur des commits** rejoue le contrôle sur le commit de fusion
   poussé sur `main` ;
3. le workflow **Tests** exécute `npm test` (14 suites, base PostgreSQL jetable) ;
4. Vercel déploie la production et réattribue `https://transia-sooty.vercel.app`.

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
