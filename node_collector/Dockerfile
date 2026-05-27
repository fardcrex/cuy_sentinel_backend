FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-alpine
RUN addgroup -S collector && adduser -S collector -G collector
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
USER collector
CMD ["node", "src/main.js"]
