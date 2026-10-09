# Multiplayer AI in a container. Build and run from the repo root with one command (see the README).
#
# Two stages: the first installs packages and builds the web app; the second holds only what
# runs. Nothing from your computer's node_modules, no .env and no tests end up in the image
# (.dockerignore keeps them out of the build, and the first stage removes any that slip in).

FROM node:24-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json server/
COPY web/package.json web/package-lock.json web/
RUN cd server && npm ci --omit=dev && cd ../web && npm ci
COPY server server
COPY web web
RUN rm -rf server/test server/supabase-lib \
 && rm -f .env .env.* server/.env server/.env.* web/.env web/.env.* \
 && cd web && npm run build

FROM node:24-slim
# MULTIPLAYER_AI_CONTAINER only takes effect because this really is a container (see server/container.js).
ENV MULTIPLAYER_AI_CONTAINER=1 \
    MULTIPLAYER_AI_NO_DOTENV=1 \
    MULTIPLAYER_AI_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -m 700 /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3737
CMD ["node", "server/local.js"]
