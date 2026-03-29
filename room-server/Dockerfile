FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY src/ ./src/
RUN mkdir -p /data/recordings
ENV PORT=2567
ENV DATA_DIR=/data/recordings
EXPOSE 2567
CMD ["node", "src/index.js"]
