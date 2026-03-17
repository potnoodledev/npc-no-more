FROM node:20-slim

# Install git (needed by pi for some operations)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pi-mono from the submodule
COPY references/pi-mono/ /app/pi-mono/
RUN cd /app/pi-mono && npm install && npm run build 2>/dev/null || true
RUN cd /app/pi-mono/packages/coding-agent && npm link

# Install bridge dependencies
COPY pi-bridge/package.json /app/bridge/
RUN cd /app/bridge && npm install

COPY pi-bridge/server.js /app/bridge/
COPY pi-bridge/nim-models.json /app/bridge/

# Create workspace
RUN mkdir -p /workspace

ENV PORT=3457
ENV WORKSPACE=/workspace
ENV PI_BIN=pi

EXPOSE 3457
WORKDIR /app/bridge
CMD ["node", "server.js"]
