# Utilise Node.js LTS
FROM node:18

# Crée un dossier dans le conteneur
WORKDIR /app

# Copie tous les fichiers de ton projet Node.js
COPY . .

# Installe les dépendances
RUN npm install

# Expose le port utilisé (ex. 3000)
EXPOSE 3000

# Lance le serveur
CMD ["npm", "start"]
