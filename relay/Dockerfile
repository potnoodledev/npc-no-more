FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

RUN mkdir -p /data

ENV PORT=7777
ENV DATA_DIR=/data

EXPOSE 7777

CMD ["node", "server.js"]
