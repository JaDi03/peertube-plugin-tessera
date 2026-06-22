# Build and package the plugin
Write-Host "1. Building the plugin..."
npm run build
npm pack

# Find the latest tarball
$Tarball = Get-ChildItem -Filter "peertube-plugin-tessera-*.tgz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $Tarball) {
    Write-Host "Error: Tarball not found. Build may have failed."
    exit 1
}

# Prepare the container and copy the file
Write-Host "2. Copying the plugin to Docker..."
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" exec docker-peertube-peertube-1 sh -c "rm -rf /tmp/peertube-plugin-tessera /tmp/peertube-plugin-tessera-*.tgz"
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" cp $Tarball.FullName docker-peertube-peertube-1:/tmp/

# Extract and install using the internal PeerTube CLI
Write-Host "3. Installing in PeerTube..."
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" exec docker-peertube-peertube-1 sh -c "mkdir -p /tmp/peertube-plugin-tessera && tar -xzf /tmp/$($Tarball.Name) -C /tmp/peertube-plugin-tessera --strip-components=1 && npm run plugin:install -- --plugin-path /tmp/peertube-plugin-tessera"

Write-Host "========================================="
Write-Host "Plugin updated and reloaded successfully!"
Write-Host "========================================="
