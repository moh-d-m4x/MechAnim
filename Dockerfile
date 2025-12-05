# Use official Node.js image
FROM node:22-alpine


# Set working directory
WORKDIR /app

# Copy package files
COPY package.json

# Install dependencies
RUN npm install

# Copy rest of the source code
COPY . .

# Build the project (if you use a build step)
RUN npm run build

# Expose port (adjust if needed)
EXPOSE 3000

# Start the app (adjust start command if different)
CMD ["npm", "run", "dev"]
