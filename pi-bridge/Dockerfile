FROM node:20-slim

# Install git (needed by pi for some operations)
RUN apt-get update && apt-get install -y git jq curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pi coding agent from npm
RUN npm install -g @mariozechner/pi-coding-agent

# Install bridge dependencies
COPY package.json package-lock.json* /app/bridge/
RUN cd /app/bridge && npm install

COPY server.js profile.js prompt-builder.js nostr-auth.js nim-models.json /app/bridge/
COPY skill-templates/ /app/bridge/skill-templates/

# Create workspace
RUN mkdir -p /workspace

ENV PORT=3457
ENV WORKSPACE=/workspace
ENV PI_BIN=pi

EXPOSE 3457
WORKDIR /app/bridge
CMD ["node", "server.js"]
