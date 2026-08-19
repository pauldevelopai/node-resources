#!/bin/bash
# Resources — Mac launcher
# Double-click this file to start the app.

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js isn't installed yet."
  echo "Go to https://nodejs.org and download the LTS version."
  echo "Then double-click this file again."
  echo ""
  read -p "Press Enter to close this window."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First-time setup: installing the app's parts..."
  npm install
fi

echo ""
echo "Starting Resources..."
echo ""

# Open the browser after a short delay
( sleep 2 && open http://localhost:3000 ) &

npm start
