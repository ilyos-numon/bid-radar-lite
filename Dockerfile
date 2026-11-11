FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app ./app
COPY src ./src
COPY config ./config
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app/data

# 기존 모드 데이터(PGlite)는 볼륨 안 data/pg. 가입 모드는 APP_DB_URL(공유 Postgres)을 쓴다
ENV NODE_ENV=production APP_PORT=8820 APP_DATA_DIR=/app/data/pg

VOLUME /app/data
EXPOSE 8820

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8820/healthz || exit 1

CMD ["node", "--no-warnings=ExperimentalWarning", "app/server.mjs"]
