FROM node:22-alpine
WORKDIR /app

# Install git (dibutuhkan oleh dependency Baileys)
RUN apk add --no-cache git

COPY package.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]
