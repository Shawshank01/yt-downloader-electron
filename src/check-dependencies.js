import { exit, stdin as input, stdout as output } from 'process';
import readline from 'readline/promises';
import { checkSystemDependencies, installMissingDependencies } from './dependencies.js';

async function runPrestartCheck() {
    console.log('Checking required dependencies...');

    const result = await checkSystemDependencies();
    if (!result.success) {
        console.error('Error checking dependencies:', result.message);
        exit(1);
    }

    // Print status for already installed dependencies
    for (const dep of result.dependencies) {
        if (dep.installed) {
            if (dep.name === 'ffmpeg' && dep.hasSubtitlesFilter === false) {
                console.log(`⚠️  ffmpeg is installed (missing libass / subtitles filter)`);
                console.log(`   👉 To enable video hardsubbing on macOS, run: brew install ffmpeg-full or sudo port install ffmpeg`);
            } else {
                console.log(`✅ ${dep.name} is installed (${dep.path})`);
            }
        }
    }

    if (result.allInstalled) {
        console.log('\nAll dependencies are satisfied! Starting the app...\n');
        return;
    }

    const isMac = process.platform === 'darwin';
    if (!isMac) {
        for (const name of result.missing) {
            console.error(`\n❌ ${name} is not installed. Please install it manually via your OS package manager.`);
        }
        exit(1);
    }

    for (const name of result.missing) {
        console.log(`\n❌ ${name} is not installed.`);
    }

    const hasBrew = Boolean(result.packageManagers?.brew?.installed);
    const hasPort = Boolean(result.packageManagers?.port?.installed);

    const manualHints = [];
    if (hasPort) {
        manualHints.push(`MacPorts:\n   sudo port install ${result.missing.join(' ')}`);
    }
    if (hasBrew) {
        manualHints.push(`Homebrew:\n   brew install ${result.missing.join(' ')}`);
    }
    if (!hasPort && !hasBrew) {
        manualHints.push(`Homebrew:\n   brew install ${result.missing.join(' ')}`);
        manualHints.push(`MacPorts:\n   sudo port install ${result.missing.join(' ')}`);
    }

    // In a non-interactive shell/CI, don't block on stdin
    if (!input.isTTY) {
        console.log('\nNon-interactive terminal detected.');
        console.log(`To install missing dependencies manually, run:\n   ${manualHints.join('\n\n   ')}\n`);
        return;
    }

    // If Homebrew is available, offer interactive auto-installation
    if (hasBrew) {
        const rl = readline.createInterface({ input, output });
        const answer = await rl.question(
            `\nWould you like to install missing dependencies (${result.missing.join(', ')}) via Homebrew now? [y/N]: `
        );
        rl.close();

        if (answer.trim().toLowerCase() === 'y') {
            console.log('\nInstalling via Homebrew...');
            const installResult = await installMissingDependencies({
                onProgress: (msg) => console.log(msg)
            });

            if (!installResult.success) {
                console.error('Failed to install dependencies:', installResult.message);
                if (installResult.failed?.length) {
                    console.error('Failed items:', installResult.failed.join(', '));
                }
                exit(1);
            }

            for (const name of installResult.installed) {
                console.log(`✅ ${name} has been installed`);
            }

            console.log('\nAll dependencies are satisfied! Starting the app...\n');
            return;
        }
    }

    console.log('\nYou can install missing dependencies manually with:');
    for (const hint of manualHints) {
        console.log(`   ${hint}`);
    }
    console.log('\nStarting the app...\n');
}

runPrestartCheck().catch((error) => {
    console.error('Error checking dependencies:', error);
    exit(1);
});
