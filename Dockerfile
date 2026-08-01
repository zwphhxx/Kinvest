FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY server ./server
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runtime

LABEL io.kinvest.schema.min="0" \
      io.kinvest.schema.max="0"

ENV NODE_ENV=production \
    PORT=4173 \
    KINVEST_DB_PATH=/data/kinvest.sqlite

RUN addgroup -g 10001 -S kinvest && \
    adduser -S -D -H -u 10001 -G kinvest -s /sbin/nologin kinvest

WORKDIR /app

COPY --from=build --chown=10001:10001 /app/dist ./

USER 10001:10001

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4173/api/health || exit 1

CMD ["node", "server/server.js"]
