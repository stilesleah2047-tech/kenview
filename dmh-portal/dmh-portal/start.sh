#!/usr/bin/env bash
# Starts the reporting server and opens it in your browser. Ctrl-C stops it.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Get it from https://nodejs.org (version 18 or newer),"
  echo "  then run this again."
  echo
  exit 1
fi

# First run: create server/.env with a freshly generated signing secret.
if [ ! -f server/.env ]; then
  echo "  First run - creating server/.env"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" server/.env.example > server/.env
  echo "  A signing secret was generated."
  echo "  Add MONGODB_URI to server/.env before you set up real clients."
fi

# The MongoDB driver is only needed once a database is configured.
if grep -qE '^MONGODB_URI=.+' server/.env && [ ! -d server/node_modules/mongodb ]; then
  echo "  MongoDB is configured but its driver is missing. Installing it once..."
  ( cd server && npm install --omit=dev --no-audit --no-fund ) || {
    echo
    echo "  Could not install the driver. Run this yourself, then start again:"
    echo "      cd server && npm install"
    echo
    exit 1
  }
fi

PORT=$(grep -E '^PORT=' server/.env | cut -d= -f2 | tr -d '[:space:]')
PORT=${PORT:-4000}
URL="http://localhost:$PORT/"

( sleep 1.5
  if   command -v open     >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &

exec node server/src/server.js
