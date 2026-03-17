FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js nostr-auth.js ./
RUN mkdir -p /data/images
ENV PORT=3456
ENV DATA_DIR=/data/images
EXPOSE 3456
CMD ["node", "server.js"]
