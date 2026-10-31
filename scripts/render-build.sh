#!/bin/sh
set -eu

phase="${1:-all}"

build_frontend() {
  cd frontend
  npm ci
  npm run build
}

build_backend() {
  POETRY_VIRTUALENVS_CREATE=false poetry install --only main --no-root --no-interaction --no-ansi
}

case "$phase" in
  frontend)
    build_frontend
    ;;
  backend)
    build_backend
    ;;
  all)
    build_backend
    build_frontend
    ;;
  *)
    echo "Usage: $0 [frontend|backend|all]" >&2
    exit 2
    ;;
esac
