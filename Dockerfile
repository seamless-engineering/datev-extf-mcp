# For MCP directories that build and inspect the server (e.g. Glama).
# Locally, run it with npx instead: the server reads files by path, which a
# container only sees through a volume mount.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
WORKDIR /data
COPY --from=build /app/package.json /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
USER node
ENTRYPOINT ["node", "/app/dist/index.js"]
