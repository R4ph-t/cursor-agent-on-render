#!/usr/bin/env bash

set -euo pipefail

: "${CURSOR_TARGET_REPOSITORY:?CURSOR_TARGET_REPOSITORY is required}"

WORKER_DIR="${CURSOR_WORKER_DIR:-/workspace/repo}"
TARGET_REPOSITORY="${CURSOR_TARGET_REPOSITORY}"
TARGET_REF="${CURSOR_TARGET_REF:-}"
GIT_USERNAME="${CURSOR_GIT_USERNAME:-x-access-token}"

mkdir -p "$(dirname "$WORKER_DIR")"

auth_repository_url() {
  local repo_url="$1"

  if [[ -n "${CURSOR_GIT_TOKEN:-}" ]]; then
    if [[ "$repo_url" != https://* ]]; then
      echo "CURSOR_GIT_TOKEN currently supports only HTTPS clone URLs." >&2
      exit 1
    fi

    echo "${repo_url/https:\/\//https://${GIT_USERNAME}:${CURSOR_GIT_TOKEN}@}"
    return
  fi

  echo "$repo_url"
}

clone_or_update_repo() {
  local source_url
  source_url="$(auth_repository_url "$TARGET_REPOSITORY")"

  if [[ ! -d "$WORKER_DIR/.git" ]]; then
    rm -rf "$WORKER_DIR"
    git clone "$source_url" "$WORKER_DIR"
  else
    git -C "$WORKER_DIR" remote set-url origin "$source_url"
    git -C "$WORKER_DIR" fetch origin --tags --prune
  fi

  if [[ -n "$TARGET_REF" ]]; then
    git -C "$WORKER_DIR" fetch origin "$TARGET_REF" --depth 1
    git -C "$WORKER_DIR" checkout --detach FETCH_HEAD
  fi

  git -C "$WORKER_DIR" remote set-url origin "$TARGET_REPOSITORY"
}

append_flag_if_set() {
  local env_name="$1"
  local flag_name="$2"
  local value="${!env_name:-}"

  if [[ -n "$value" ]]; then
    WORKER_ARGS+=("$flag_name" "$value")
  fi
}

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
