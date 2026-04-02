FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /data
ENV PORT=3458
EXPOSE 3458
CMD ["node", "server.js"]
