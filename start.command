#!/bin/bash

# Get the directory where the script is located
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Change to the script's directory
cd "$DIR"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "npm is not installed. Please install Node.js and npm first."
    read -p "Press Enter to exit..."
    exit 1
fi

# Check if node_modules exists, if not run npm install
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start the application
echo "Starting YouTube Downloader..."
npm start

# If there's an error, show it and wait for user input
if [ $? -ne 0 ]; then
    echo "An error occurred. Press Enter to exit..."
    read
else
    # If successful, close the terminal after a short delay
    sleep 1
    # Get the terminal window ID
    WINDOW_ID=$(osascript -e 'tell application "Terminal" to id of window 1')
    # Close the window without confirmation
    osascript -e "tell application \"Terminal\" to close window id $WINDOW_ID" &
    # Exit the script immediately
    exit 0
fi 