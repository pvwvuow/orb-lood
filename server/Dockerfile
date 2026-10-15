FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# Run as the unprivileged `node` user that ships with the image.
RUN mkdir -p /data/uploads && chown -R node:node /app /data
USER node
EXPOSE 4000
# Apply migrations, then start (both are idempotent / safe to repeat).
CMD ["sh", "-c", "node src/scripts/init-db.js && exec node src/index.js"]
