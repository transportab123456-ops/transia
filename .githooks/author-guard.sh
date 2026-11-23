#!/bin/sh
# ============================================================
# Transia — garde-fou d'auteur de commit
#
# Vercel refuse tout déploiement dont l'auteur du commit n'est pas
# membre de l'équipe du projet (TEAM_ACCESS_REQUIRED). Le refus
# n'apparaît qu'après le push, une fois le déploiement créé puis
# bloqué. Ce script le fait apparaître avant : au moment du commit,
# puis au moment du push.
#
# Appelé par .githooks/pre-commit et .githooks/pre-push ; les deux
# hooks sont activés par `git config core.hooksPath .githooks`.
#
# Bypass volontaire (à éviter) : `git commit --no-verify` ou
# `git push --no-verify`.
# ============================================================
set -u

NOM_ATTENDU="transportab123456-ops"
COURRIEL_ATTENDU="transportab123456@gmail.com"
ATTENDU="$NOM_ATTENDU <$COURRIEL_ATTENDU>"
ZERO="0000000000000000000000000000000000000000"

refuser() {
  echo "Auteur refusé : $1" >&2
  echo "Attendu : $ATTENDU" >&2
  echo "Vercel bloquerait ce déploiement (TEAM_ACCESS_REQUIRED)." >&2
  echo "Corrigez l'identité :" >&2
  echo "  git config --global user.name  \"$NOM_ATTENDU\"" >&2
  echo "  git config --global user.email \"$COURRIEL_ATTENDU\"" >&2
  echo "Pour un commit déjà créé : git commit --amend --reset-author" >&2
  exit 1
}

verifier() {
  # $1 = liste d'auteurs, un par ligne, au format « Nom <courriel> ».
  mauvais=$(printf '%s\n' "$1" | grep -vxF "$ATTENDU" | sed '/^$/d')
  [ -z "$mauvais" ] && return 0
  refuser "$(printf '%s' "$mauvais" | head -3 | tr '\n' ';' | sed 's/;$//')"
}

case "${1:-}" in
  commit)
    # Identité qui sera enregistrée dans le commit (auteur d'origine
    # conservé lors d'un --amend).
    ident=$(git var GIT_AUTHOR_IDENT 2>/dev/null | sed 's/ [0-9][0-9]* [-+][0-9][0-9]*$//')
    [ -n "$ident" ] || { echo "Impossible de lire l'identité Git." >&2; exit 2; }
    verifier "$ident"
    ;;
  push)
    # Entrées de stdin : <ref locale> <sha locale> <ref distante> <sha distante>
    while read -r ref_local sha_local ref_distante sha_distante; do
      case "$sha_local" in "$ZERO"|"") continue ;; esac
      if [ "$sha_distante" = "$ZERO" ]; then
        # Nouvelle branche : seulement les commits absents des remotes,
        # pour ne pas buter sur l'historique antérieur à la règle.
        auteurs=$(git log --format='%an <%ae>' "$sha_local" --not --remotes)
      else
        auteurs=$(git log --format='%an <%ae>' "$sha_distante..$sha_local")
      fi
      [ -n "$auteurs" ] || continue
      verifier "$auteurs"
    done
    ;;
  *)
    echo "usage : $0 commit|push" >&2
    exit 2
    ;;
esac
