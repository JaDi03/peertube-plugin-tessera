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

# Find the PeerTube container dynamically
CONTAINER=${PEERTUBE_CONTAINER:-$(docker ps --format '{{.Names}}' | awk '/peertube/ && !/redis/ && !/postgres/ && !/postfix/ {print; exit}')}

if [ -z "$CONTAINER" ]; then
    echo "❌ Error: Could not find PeerTube container. Is Docker running?"
    echo "You can manually set the container name like this:"
    echo "PEERTUBE_CONTAINER=my_peertube_container ./update-plugin.sh"
    exit 1
fi

echo "🎯 Using PeerTube container: $CONTAINER"
echo "🚀 Transferring $TARBALL to the PeerTube container..."

# Remove any previous leftover files
docker exec $CONTAINER sh -c "rm -rf /tmp/peertube-plugin-tessera*"

# Copy the new tarball
docker cp $TARBALL $CONTAINER:/tmp/

echo "⚙️ Installing the plugin inside the container..."

# Extract and install using the PeerTube CLI
docker exec $CONTAINER sh -c "
  mkdir -p /tmp/peertube-plugin-tessera &&
  tar -xzf /tmp/$TARBALL -C /tmp/peertube-plugin-tessera --strip-components=1 &&
  npm run plugin:install -- --plugin-path /tmp/peertube-plugin-tessera
"

echo "🔄 Restarting PeerTube to apply changes..."
docker restart $CONTAINER

echo "✅ Plugin update complete!"
