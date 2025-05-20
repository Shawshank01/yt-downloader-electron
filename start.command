#!/bin/bash

# Get the directory where the script is located
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Change to the script's directory
cd "$DIR"

# Function to show error and wait
show_error() {
    echo "❌ Error: $1"
    echo "Press Enter to exit..."
    read
    exit 1
}

# Function to show success message
show_success() {
    echo "✅ $1"
}

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    show_error "npm is not installed. Please install Node.js and npm first."
fi

# Check if node_modules exists, if not run npm install
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    if ! npm install; then
        show_error "Failed to install dependencies. Please check your internet connection and try again."
    fi
    show_success "Dependencies installed successfully"
fi

# Check if package.json exists
if [ ! -f "package.json" ]; then
    show_error "package.json not found. Please make sure you're running this script from the correct directory."
fi

# Start the application
echo "🚀 Starting YT Downloader..."
if ! npm start; then
    show_error "Failed to start the application. Please check the error message above."
fi

# If successful, close the terminal after a short delay
sleep 1
# Get the terminal window ID
WINDOW_ID=$(osascript -e 'tell application "Terminal" to id of window 1')
# Close the window without confirmation
osascript -e "tell application \"Terminal\" to close window id $WINDOW_ID" &
# Exit the script immediately
exit 0 