FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY server ./server
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=4173 \
    KINVEST_DB_PATH=/data/kinvest.sqlite

WORKDIR /app

COPY --from=build --chown=node:node /app/dist ./

USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4173/api/health || exit 1

CMD ["node", "server/server.js"]
