# syntax=docker/dockerfile:1
FROM node:26-alpine AS deps

WORKDIR /app

RUN npm install -g pnpm@12.18.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Dev dependencies are needed for the esbuild step. Install scripts are skipped:
# the bundle only needs sources. The pnpm store is a BuildKit cache mount shared
# with the other projects (id=pnpm-store).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store

FROM node:26-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.ts app.ts tsconfig.json ./
COPY middleware ./middleware
COPY routes ./routes
COPY utils ./utils

RUN node_modules/.bin/esbuild server.ts --bundle --platform=node --format=esm --target=node26 \
  --outdir=./dist --external:pg-native --minify \
  --banner:js="import { createRequire as __flixaCreateRequire } from 'node:module'; const require = __flixaCreateRequire(import.meta.url);"

# Distroless: Node.js and its runtime libraries only (no shell, package manager,
# or npm). The `nonroot` tag runs as uid 65532 and its entrypoint is `node`.
# For an interactive shell while debugging, swap in the `debug-nonroot` tag.
FROM gcr.io/distroless/nodejs26-debian13:nonroot AS app

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Self-contained ESM bundle; .mjs so Node does not need a package.json "type".
COPY --from=build /app/dist/server.js ./server.mjs

EXPOSE 3000

# The image's entrypoint is already `node`, so CMD carries only the script.
CMD ["server.mjs"]
