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

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    show_error "pnpm is not installed. Please install pnpm first (e.g. npm install -g pnpm or brew install pnpm)."
fi

# Check if node_modules exists, if not run pnpm install
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    if ! pnpm install; then
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
if ! pnpm start; then
    show_error "Failed to start the application. Please check the error message above."
fi

# After exiting, close the terminal window corresponding to this session
sleep 1
# Get the current TTY and find the corresponding Terminal window/tab
CURRENT_TTY=$(tty)
osascript -e "
delay 1
tell application \"Terminal\"
    repeat with w in windows
        repeat with t in tabs of w
            if tty of t is \"$CURRENT_TTY\" then
                close w
                return
            end if
        end repeat
    end repeat
end tell
" &
exit 0