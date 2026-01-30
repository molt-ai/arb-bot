FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

EXPOSE 3456

CMD ["node", "src/live.js"]
