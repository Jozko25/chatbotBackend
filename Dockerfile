# Cache bust: 2026-01-19
FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm install

# Generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

ENV PORT=3001
EXPOSE 3001

# Use start:prod which doesn't require .env file (Railway provides env vars)
CMD ["npm", "run", "start:prod"]
