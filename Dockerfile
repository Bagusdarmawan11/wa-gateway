FROM node:22-alpine
WORKDIR /app
# Menyalin package.json saja
COPY package.json ./
# Memaksa menggunakan npm install biasa
RUN npm install
# Menyalin sisa kode aplikasi
COPY . .
# Jalankan aplikasi
CMD ["npm", "start"]
