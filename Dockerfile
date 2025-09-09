# Use official Playwright image (includes Chromium + dependencies)
FROM mcr.microsoft.com/playwright:v1.54.0-jammy

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application source
COPY . .

# Expose app port
EXPOSE 8080

# Run your scraper
CMD ["node", "index.js"]
