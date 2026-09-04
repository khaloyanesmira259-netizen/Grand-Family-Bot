FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
RUN npm run verify

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV SQLITE_PATH=/app/data/families.sqlite
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY host-launcher.mjs ./

RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
USER node

EXPOSE 8080
CMD ["node", "--enable-source-maps", "./host-launcher.mjs"]