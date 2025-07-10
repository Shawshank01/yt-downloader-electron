#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message) {
    log(`❌ Error: ${message}`, 'red');
    process.exit(1);
}

function success(message) {
    log(`✅ ${message}`, 'green');
}

function info(message) {
    log(`ℹ️  ${message}`, 'blue');
}

function warning(message) {
    log(`⚠️  ${message}`, 'yellow');
}

// Get command line arguments
const args = process.argv.slice(2);
const versionType = args[0]; // 'patch', 'minor', 'major', or specific version like '2.2.3'

if (!versionType) {
    error('Please specify version type: patch, minor, major, or specific version (e.g., 2.2.3)');
    process.exit(1);
}

try {
    // Read current package.json
    const packagePath = join(__dirname, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const currentVersion = packageJson.version;

    log(`Current version: ${currentVersion}`, 'cyan');

    let newVersion;

    // Determine new version
    if (versionType === 'patch' || versionType === 'minor' || versionType === 'major') {
        const [major, minor, patch] = currentVersion.split('.').map(Number);

        switch (versionType) {
            case 'patch':
                newVersion = `${major}.${minor}.${patch + 1}`;
                break;
            case 'minor':
                newVersion = `${major}.${minor + 1}.0`;
                break;
            case 'major':
                newVersion = `${major + 1}.0.0`;
                break;
        }
    } else {
        // Specific version provided
        if (!/^\d+\.\d+\.\d+$/.test(versionType)) {
            error('Invalid version format. Use semantic versioning (e.g., 2.2.3)');
        }
        newVersion = versionType;
    }

    log(`New version: ${newVersion}`, 'cyan');

    // Interactive version selection
    const readline = await import('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    let selectedVersion = newVersion;
    let confirmed = false;

    while (!confirmed) {
        const [major, minor, patch] = currentVersion.split('.').map(Number);
        
        log('\n📋 Available version options:', 'cyan');
        log(`1. Patch: ${major}.${minor}.${patch + 1} (bug fixes)`, 'yellow');
        log(`2. Minor: ${major}.${minor + 1}.0 (new features)`, 'yellow');
        log(`3. Major: ${major + 1}.0.0 (breaking changes)`, 'yellow');
        log(`4. Custom: Enter specific version`, 'yellow');
        log(`5. Cancel: Exit without updating`, 'red');

        const choice = await new Promise((resolve) => {
            rl.question(`\nSelect version type (1-5) or press Enter for ${newVersion}: `, resolve);
        });

        switch (choice.trim()) {
            case '1':
                selectedVersion = `${major}.${minor}.${patch + 1}`;
                break;
            case '2':
                selectedVersion = `${major}.${minor + 1}.0`;
                break;
            case '3':
                selectedVersion = `${major + 1}.0.0`;
                break;
            case '4':
                const customVersion = await new Promise((resolve) => {
                    rl.question('Enter custom version (e.g., 2.3.0): ', resolve);
                });
                if (/^\d+\.\d+\.\d+$/.test(customVersion.trim())) {
                    selectedVersion = customVersion.trim();
                } else {
                    log('❌ Invalid version format. Use semantic versioning (e.g., 2.3.0)', 'red');
                    continue;
                }
                break;
            case '5':
                info('Version update cancelled.');
                rl.close();
                process.exit(0);
            case '':
                // Use the originally calculated version
                selectedVersion = newVersion;
                break;
            default:
                log('❌ Invalid choice. Please select 1-5 or press Enter.', 'red');
                continue;
        }

        log(`\nSelected version: ${selectedVersion}`, 'green');
        
        const confirm = await new Promise((resolve) => {
            rl.question(`Confirm update from ${currentVersion} to ${selectedVersion}? (y/N): `, resolve);
        });

        if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
            confirmed = true;
        } else {
            log('Let\'s try a different version...', 'blue');
        }
    }

    rl.close();

    // Ask if user wants to write custom release notes
    const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const customNotes = await new Promise((resolve) => {
        rl2.question(`\nDo you want to write custom release notes? (y/N): `, resolve);
    });

    let commitMessage = `Bump version to ${selectedVersion}`;
    let releaseNotes = '';

    if (customNotes.toLowerCase() === 'y' || customNotes.toLowerCase() === 'yes') {
        log('\n📝 Please enter your custom release notes (press Enter twice to finish):', 'cyan');
        log('(You can use markdown formatting)', 'yellow');
        
        const notes = [];
        let lineCount = 0;
        
        while (true) {
            const line = await new Promise((resolve) => {
                rl2.question(lineCount === 0 ? 'Release notes: ' : '> ', resolve);
            });
            
            if (line === '' && lineCount > 0) {
                break; // Empty line after content means done
            }
            
            notes.push(line);
            lineCount++;
        }
        
        releaseNotes = notes.join('\n');
        commitMessage = `Bump version to ${selectedVersion}\n\n${releaseNotes}`;
        
        log('\n📋 Your release notes:', 'cyan');
        console.log(releaseNotes);
    }
    
    rl2.close();

    // Check if git is clean
    try {
        const gitStatus = execSync('git status --porcelain', { encoding: 'utf8' });
        if (gitStatus.trim()) {
            warning('Git working directory is not clean. Please commit or stash your changes first.');
            log('Uncommitted changes:', 'yellow');
            console.log(gitStatus);
            process.exit(1);
        }
    } catch (err) {
        error('Failed to check git status. Make sure you are in a git repository.');
    }

    // Update package.json
    packageJson.version = selectedVersion;
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
    success(`Updated package.json to version ${selectedVersion}`);

    // Commit the version change
    try {
        execSync('git add package.json');
        execSync(`git commit -m "${commitMessage}"`);
        success('Committed version change');
    } catch (err) {
        error('Failed to commit version change: ' + err.message);
    }

    // Create and push git tag
    try {
        const tagName = `v${selectedVersion}`;
        execSync(`git tag ${tagName}`);
        success(`Created git tag: ${tagName}`);

        execSync(`git push origin ${tagName}`);
        success(`Pushed tag ${tagName} to GitHub`);

        // Push the commit as well
        execSync('git push origin main');
        success('Pushed commit to GitHub');

    } catch (err) {
        error('Failed to create/push tag: ' + err.message);
    }

    log('\n🎉 Version update completed successfully!', 'green');
    log(`📦 New version: ${selectedVersion}`, 'cyan');
    log(`🏷️  Git tag: v${selectedVersion}`, 'cyan');
    log('🚀 GitHub Actions will automatically build and release the new version.', 'cyan');

} catch (err) {
    error('Script failed: ' + err.message);
} 