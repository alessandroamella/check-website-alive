#!/bin/bash

# Website Monitor Setup Script

set -e

echo "🚀 Setting up Website Monitor Service..."

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo "This script should not be run as root. Please run as a regular user."
   exit 1
fi

# Create project directory
PROJECT_DIR="/opt/website-monitor"
echo "📁 Creating project directory at $PROJECT_DIR"
sudo mkdir -p $PROJECT_DIR
sudo chown $USER:$USER $PROJECT_DIR

# Copy files to project directory
echo "📋 Copying project files..."
cp -r . $PROJECT_DIR/
cd $PROJECT_DIR

# Create src directory and move main file
mkdir -p src
cp index.ts src/ 2>/dev/null || echo "index.ts not found, assuming it's already in src/"

# Install dependencies
echo "📦 Installing dependencies with pnpm..."
if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi

pnpm install

# Build the project
echo "🔨 Building the project..."
pnpm run build

# Set up environment file
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "⚠️  Please edit .env file with your Telegram bot token and chat ID"
fi

# Set up URLs file
if [ ! -f urls.txt ]; then
    echo "📝 Creating urls.txt file..."
    cat > urls.txt << 'EOF'
# Website URLs to monitor
# One URL per line, comments start with #

https://www.wolfsurvival.it/
https://www.bitrey.it/

# Add more URLs below
EOF
fi

# Set proper permissions
sudo chown -R www-data:www-data $PROJECT_DIR
sudo chmod -R 755 $PROJECT_DIR

# Install systemd service
echo "⚙️  Installing systemd service..."
sudo cp website-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit $PROJECT_DIR/.env with your Telegram bot token and chat ID"
echo "2. Edit $PROJECT_DIR/urls.txt with your website URLs"
echo "3. Start the service: sudo systemctl start website-monitor"
echo "4. Enable auto-start: sudo systemctl enable website-monitor"
echo "5. Check status: sudo systemctl status website-monitor"
echo "6. View logs: journalctl -u website-monitor -f"
echo ""
echo "To get your Telegram bot token:"
echo "1. Message @BotFather on Telegram"
echo "2. Create a new bot with /newbot command"
echo "3. Copy the token to your .env file"
echo ""
echo "To get your chat ID:"
echo "1. Message your bot"
echo "2. Visit: https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
echo "3. Look for the chat.id value"
