# Minimal image so registries (e.g. Glama) can start the server and introspect it.
# The server speaks MCP over stdio.
FROM node:20-slim

WORKDIR /app

# Install production dependencies against the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the server source.
COPY src ./src

# MODRINTH_TOKEN is optional: read-only tools work without it; write actions require it.
ENV NODE_ENV=production

ENTRYPOINT ["node", "src/index.js"]
