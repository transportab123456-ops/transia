#!/bin/sh
# ============================================================
# Transia — garde-fou d'auteur de commit
#
# Vercel refuse un déploiement dont l'auteur du commit n'est pas
# membre de l'équipe (TEAM_ACCESS_REQUIRED), et ce refus n'apparaît
# qu'après le push. Ce script le fait apparaître au commit, puis au
# push. Appelé par .githooks/pre-commit, .githooks/pre-merge-commit
# et .githooks/pre-push, activés par `core.hooksPath=.githooks`
# (install-git-hooks.js).
#
# `git commit --no-verify` et `git push --no-verify` contournent.
# ============================================================
set -u

ATTENDU="transportab123456-ops <transportab123456@gmail.com>"
ZERO="0000000000000000000000000000000000000000"

refuser() {
  echo "Auteur refusé : $1" >&2
  echo "Attendu : $ATTENDU" >&2
  echo "Vercel bloquerait ce déploiement (TEAM_ACCESS_REQUIRED)." >&2
  echo "  git config --global user.name  \"transportab123456-ops\"" >&2
  echo "  git config --global user.email \"transportab123456@gmail.com\"" >&2
  echo "Commit déjà créé : git commit --amend --reset-author" >&2
  exit 1
}

# $1 : auteurs, un par ligne, au format « Nom <courriel> ».
# Une liste vide (rien à pousser, tout est déjà sur le remote) passe.
verifier() {
  [ -n "${1:-}" ] || return 0
  mauvais=$(printf '%s\n' "$1" | grep -vxF "$ATTENDU")
  [ -z "$mauvais" ] || refuser "$(printf '%s\n' "$mauvais" | head -1)"
}

case "${1:-}" in
  commit)
    # « Nom <courriel> <horodatage> <fuseau> » ; l'auteur d'origine est
    # conservé par --amend, donc c'est bien lui qui sera enregistré.
    ident=$(git var GIT_AUTHOR_IDENT 2>/dev/null) || {
      echo "Impossible de lire l'identité Git." >&2
      exit 2
    }
    case "$ident" in
      "$ATTENDU "*) ;;
      *) refuser "${ident% * *}" ;;
    esac
    ;;
  push)
    # stdin : <ref locale> <sha locale> <ref distante> <sha distante>
    while read -r ref_local sha_local ref_distante sha_distante; do
      case "$sha_local" in "$ZERO"|"") continue ;; esac
      if [ "$sha_distante" = "$ZERO" ]; then
        # Branche ou étiquette neuve : ignorer l'historique antérieur
        # à la règle, qui n'est pas poussé ici.
        verifier "$(git log --format='%an <%ae>' "$sha_local" --not --remotes)"
      else
        verifier "$(git log --format='%an <%ae>' "$sha_distante..$sha_local")"
      fi
    done
    ;;
  *)
    echo "usage : $0 commit|push" >&2
    exit 2
    ;;
esac
