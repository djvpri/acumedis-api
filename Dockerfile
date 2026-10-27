FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src

ENV PORT=3000
ENV UPLOAD_DIR=/data/uploads
EXPOSE 3000

# db push supaya tabel selalu sinkron dengan schema saat container naik
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node src/server.js"]
