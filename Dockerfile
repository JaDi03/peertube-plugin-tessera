# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production (PeerTube plugins are usually published as npm packages, 
# but this Dockerfile is provided as per project scaffold requirements)
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
# Plugins don't usually run as standalone servers, but if needed:
CMD ["echo", "PeerTube plugin ready to be published"]
