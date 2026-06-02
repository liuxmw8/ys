FROM node:20-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY index.html data.json ./
COPY assets ./assets
COPY server ./server

ENV NODE_ENV=production
ENV PORT=3000
ENV PUBLIC_DIR=/app
ENV DATA_DIR=/app/runtime

EXPOSE 3000

CMD ["node", "server/server.js"]
