#!/bin/zsh

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Change to the script directory
cd "$SCRIPT_DIR"

echo "Script directory: $SCRIPT_DIR"
echo "Current working directory: $(pwd)"
echo "Files in current directory:"
ls -la

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed or not in PATH"
    echo "Please install Node.js and try again."
    read -p "Press Enter to exit..."
    exit 1
fi

# Check if the update-version.js file exists
if [ ! -f "update-version.js" ]; then
    echo "❌ Error: update-version.js not found in $(pwd)"
    echo "Make sure this script is in the same directory as update-version.js"
    read -p "Press Enter to exit..."
    exit 1
fi

echo "🚀 Starting version update (patch)..."
echo "Current directory: $(pwd)"
echo ""

# Run the version update script
node update-version.js patch

# Check if the script was successful
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Version update completed successfully!"
    echo "The window will close automatically in 3 seconds..."
    sleep 3
    exit 0
else
    echo ""
    echo "❌ Version update failed!"
    echo "Press Enter to close this window..."
    read
    exit 1
fi 