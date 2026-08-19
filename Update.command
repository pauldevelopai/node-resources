#!/bin/bash
# Resources — Mac update launcher
# Double-click to fetch the latest version from GitHub.

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Install from https://nodejs.org first."
  read -p "Press Enter to close."
  exit 1
fi

node update.mjs

echo ""
read -p "Press Enter to close this window."
