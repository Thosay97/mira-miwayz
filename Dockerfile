FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install --production

# Copy app files
COPY server.js ./
COPY public/ ./public/
COPY knowledge.md.disabled ./

# Don't copy .env -- use Fly.io secrets instead

EXPOSE 3001

CMD ["node", "server.js"]
