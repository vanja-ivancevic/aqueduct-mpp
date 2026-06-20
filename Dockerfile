# syntax=docker/dockerfile:1
# Aqueduct Tap server — one portable image, run locally via docker compose.
# The container is stateless: it onboards a baked dataset deterministically at boot, then serves it.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8402
# Prod deps only (rebuilds the DuckDB native binary for this base image).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY examples ./examples
COPY deploy/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
EXPOSE 8402
ENTRYPOINT ["./entrypoint.sh"]
