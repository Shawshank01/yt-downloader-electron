import { exec } from 'child_process';
import { promisify } from 'util';
import { exit } from 'process';

const execAsync = promisify(exec);

async function checkCommand(command) {
    try {
        await execAsync(command);
        return true;
    } catch (error) {
        return false;
    }
}

async function checkDependencies() {
    console.log('Checking required dependencies...');

    // Check for Homebrew
    const hasHomebrew = await checkCommand('which brew');
    if (!hasHomebrew) {
        console.error('\n❌ Homebrew is not installed. Please install it first:');
        console.error(
            '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        );
        exit(1);
    }
    console.log('✅ Homebrew is installed');

    // Check for yt-dlp
    const hasYtDlp = await checkCommand('which yt-dlp');
    if (!hasYtDlp) {
        console.error('\n❌ yt-dlp is not installed. Installing via Homebrew...');
        try {
            await execAsync('brew install yt-dlp');
            console.log('✅ yt-dlp has been installed');
        } catch (error) {
            console.error('Failed to install yt-dlp:', error.message);
            exit(1);
        }
    } else {
        console.log('✅ yt-dlp is installed');
    }

    // Check for ffmpeg
    const hasFfmpeg = await checkCommand('which ffmpeg');
    if (!hasFfmpeg) {
        console.error('\n❌ ffmpeg is not installed. Installing via Homebrew...');
        try {
            await execAsync('brew install ffmpeg');
            console.log('✅ ffmpeg has been installed');
        } catch (error) {
            console.error('Failed to install ffmpeg:', error.message);
            exit(1);
        }
    } else {
        console.log('✅ ffmpeg is installed');
    }

    console.log('\nAll dependencies are satisfied! Starting the app...\n');
}

checkDependencies().catch((error) => {
    console.error('Error checking dependencies:', error);
    exit(1);
});
