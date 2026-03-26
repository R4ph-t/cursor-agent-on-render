#!/usr/bin/env bash

set -euo pipefail

: "${CURSOR_TARGET_REPOSITORY:?CURSOR_TARGET_REPOSITORY is required}"

WORKER_DIR="${CURSOR_WORKER_DIR:-/workspace/repo}"
TARGET_REPOSITORY="${CURSOR_TARGET_REPOSITORY}"
TARGET_REF="${CURSOR_TARGET_REF:-}"
GIT_USERNAME="${CURSOR_GIT_USERNAME:-x-access-token}"

mkdir -p "$(dirname "$WORKER_DIR")"

configure_git_auth() {
  if [[ -z "${CURSOR_GIT_TOKEN:-}" ]]; then
    return
  fi

  if [[ "$TARGET_REPOSITORY" != https://* ]]; then
    echo "CURSOR_GIT_TOKEN currently supports only HTTPS repository URLs." >&2
    exit 1
  fi

  local repo_host
  repo_host="$(printf '%s' "$TARGET_REPOSITORY" | sed -E 's#https?://([^/]+)/.*#\1#')"

  # Rewrites HTTPS git traffic for the target host so clone, fetch, and push
  # all use the provided token without baking credentials into the remote URL.
  git config --global \
    "url.https://${GIT_USERNAME}:${CURSOR_GIT_TOKEN}@${repo_host}/.insteadOf" \
    "https://${repo_host}/"
}

clone_or_update_repo() {
  if [[ ! -d "$WORKER_DIR/.git" ]]; then
    rm -rf "$WORKER_DIR"
    git clone "$TARGET_REPOSITORY" "$WORKER_DIR"
  else
    git -C "$WORKER_DIR" remote set-url origin "$TARGET_REPOSITORY"
    git -C "$WORKER_DIR" fetch origin --tags --prune
  fi

  if [[ -n "$TARGET_REF" ]]; then
    git -C "$WORKER_DIR" fetch origin "$TARGET_REF" --depth 1
    git -C "$WORKER_DIR" checkout --detach FETCH_HEAD
  fi
}

append_flag_if_set() {
  local env_name="$1"
  local flag_name="$2"
  local value="${!env_name:-}"

  if [[ -n "$value" ]]; then
    WORKER_ARGS+=("$flag_name" "$value")
  fi
}

configure_git_auth
clone_or_update_repo

declare -a WORKER_ARGS
WORKER_ARGS=("worker" "start" "--worker-dir" "$WORKER_DIR")

if [[ -n "${CURSOR_API_KEY:-}" ]]; then
  WORKER_ARGS+=("--api-key" "$CURSOR_API_KEY")
fi

append_flag_if_set "CURSOR_WORKER_MANAGEMENT_ADDR" "--management-addr"
append_flag_if_set "CURSOR_WORKER_IDLE_RELEASE_TIMEOUT" "--idle-release-timeout"
append_flag_if_set "CURSOR_WORKER_LABELS_FILE" "--labels-file"

if [[ "${CURSOR_WORKER_SINGLE_USE:-false}" == "true" ]]; then
  WORKER_ARGS+=("--single-use")
fi

if [[ -n "${CURSOR_WORKER_EXTRA_ARGS:-}" ]]; then
  read -r -a EXTRA_ARGS <<< "${CURSOR_WORKER_EXTRA_ARGS}"
  WORKER_ARGS+=("${EXTRA_ARGS[@]}")
fi

exec agent "${WORKER_ARGS[@]}"
