# Build and package the plugin
Write-Host "1. Building the plugin..."
npm run build
npm pack

# Prepare the container and copy the file
Write-Host "2. Copying the plugin to Docker..."
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" exec docker-peertube-peertube-1 sh -c "rm -rf /tmp/peertube-plugin-tessera /tmp/peertube-plugin-tessera-1.0.9.tgz"
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" cp "peertube-plugin-tessera-1.0.9.tgz" docker-peertube-peertube-1:/tmp/

# Extract and install using the internal PeerTube CLI
Write-Host "3. Installing in PeerTube..."
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" exec docker-peertube-peertube-1 sh -c "mkdir -p /tmp/peertube-plugin-tessera && tar -xzf /tmp/peertube-plugin-tessera-1.0.9.tgz -C /tmp/peertube-plugin-tessera --strip-components=1 && rm -f /tmp/peertube-plugin-tessera/peertube-plugin-tessera-1.0.9.tgz && rm -f /tmp/peertube-plugin-tessera/peertube-plugin-tessera-1.0.8.tgz && npm run plugin:install -- --plugin-path /tmp/peertube-plugin-tessera"

Write-Host "========================================="
Write-Host "Plugin updated and reloaded successfully!"
Write-Host "========================================="
