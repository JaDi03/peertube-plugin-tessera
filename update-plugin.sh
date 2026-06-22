#!/bin/bash
set -e

# update-plugin.sh
# This script builds the Tessera plugin and installs it inside the PeerTube Docker container.

echo "📦 Building the Tessera Plugin..."
npm install
npm run build
npm pack

# Find the generated tarball (e.g. peertube-plugin-tessera-1.0.9.tgz)
TARBALL=$(ls peertube-plugin-tessera-*.tgz | sort -V | tail -n 1)

if [ -z "$TARBALL" ]; then
    echo "❌ Error: Tarball not found. Build may have failed."
    exit 1
fi

echo "🚀 Transferring $TARBALL to the PeerTube container..."

# Remove any previous leftover files
docker exec docker-peertube-peertube-1 sh -c "rm -rf /tmp/peertube-plugin-tessera*"

# Copy the new tarball
docker cp $TARBALL docker-peertube-peertube-1:/tmp/

echo "⚙️ Installing the plugin inside the container..."

# Extract and install using the PeerTube CLI
docker exec docker-peertube-peertube-1 sh -c "
  mkdir -p /tmp/peertube-plugin-tessera &&
  tar -xzf /tmp/$TARBALL -C /tmp/peertube-plugin-tessera --strip-components=1 &&
  npm run plugin:install -- --plugin-path /tmp/peertube-plugin-tessera
"

echo "🔄 Restarting PeerTube to apply changes..."
docker restart docker-peertube-peertube-1

echo "✅ Plugin update complete!"
