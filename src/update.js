import electron from 'electron';

const app = electron?.app || electron;

const GITHUB_REPO = 'Shawshank01/yt-downloader-electron';
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

/**
 * Compare two SemVer strings.
 * Returns true if latest > current.
 */
export function isNewerVersion(current, latest) {
    if (!current || !latest) return false;

    const cleanCurrent = current.replace(/^v/, '').trim();
    const cleanLatest = latest.replace(/^v/, '').trim();

    if (cleanCurrent === cleanLatest) return false;

    const parse = (v) => {
        const [core, prerelease] = v.split('-');
        const parts = core.split('.').map((n) => parseInt(n, 10) || 0);
        return { parts, prerelease };
    };

    const p1 = parse(cleanCurrent);
    const p2 = parse(cleanLatest);

    for (let i = 0; i < Math.max(p1.parts.length, p2.parts.length); i++) {
        const num1 = p1.parts[i] || 0;
        const num2 = p2.parts[i] || 0;
        if (num2 > num1) return true;
        if (num2 < num1) return false;
    }

    // If core versions match but one has a prerelease tag
    if (p1.prerelease && !p2.prerelease) return true;
    if (!p1.prerelease && p2.prerelease) return false;

    return false;
}

/**
 * Get the platform manifest name published by electron-builder.
 */
function getPlatformManifestName() {
    if (process.platform === 'darwin') {
        return 'latest-mac.yml';
    }
    if (process.platform === 'linux') {
        return 'latest-linux.yml';
    }
    return 'latest.yml';
}

/**
 * Check for app updates using GitHub Releases static asset manifests.
 * Avoids GitHub REST API 60 req/hr rate limits and has zero third-party dependencies.
 */
export async function checkAppUpdate() {
    const currentVersion = getCurrentVersion();
    const manifestName = getPlatformManifestName();
    const manifestUrl = `https://github.com/${GITHUB_REPO}/releases/latest/download/${manifestName}`;

    try {
        const response = await fetch(manifestUrl, {
            headers: {
                'User-Agent': `YT-Downloader/${currentVersion}`
            },
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            return {
                hasUpdate: false,
                message: `Update check failed (HTTP ${response.status})`,
                error: true
            };
        }

        const text = await response.text();
        const versionMatch = text.match(/^version:\s*([^\s#]+)/m);

        if (!versionMatch) {
            return {
                hasUpdate: false,
                message: 'Unable to parse version from update manifest',
                error: true
            };
        }

        const latestVersion = versionMatch[1];
        const hasUpdate = isNewerVersion(currentVersion, latestVersion);

        // Attempt to extract release notes if present in YAML
        let releaseNotes = '';
        const notesMatch = text.match(/^releaseNotes:\s*(.*)/m);
        if (notesMatch && notesMatch[1]) {
            releaseNotes = notesMatch[1].trim();
        } else {
            releaseNotes = `Release v${latestVersion} is available.`;
        }

        // Attempt to find architecture-matching download file (e.g. arm64 or x64)
        let downloadUrl = RELEASES_PAGE_URL;
        const arch = process.arch; // 'arm64' or 'x64'
        const fileRegex = new RegExp(`url:\\s*([^\\s]+\\.${process.platform === 'darwin' ? 'dmg' : process.platform === 'win32' ? 'exe' : 'AppImage'})`, 'g');
        const matches = [...text.matchAll(fileRegex)].map((m) => m[1]);

        const matchingFile = matches.find((f) => f.includes(arch)) || matches[0];
        if (matchingFile) {
            downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${latestVersion}/${matchingFile}`;
        }

        return {
            hasUpdate,
            currentVersion,
            version: latestVersion,
            releaseNotes,
            releaseUrl: RELEASES_PAGE_URL,
            downloadUrl,
            message: hasUpdate ? 'Update available' : 'App is up to date'
        };
    } catch (error) {
        return {
            hasUpdate: false,
            message: `Error checking app update: ${error.message}`,
            error: true
        };
    }
}

// Get current app version
export function getCurrentVersion() {
    try {
        if (app && typeof app.getVersion === 'function') {
            return app.getVersion();
        }
    } catch {
        // Fall back below
    }
    return 'Unknown';
}

// Check if update checking is supported
export function isAutoUpdaterSupported() {
    return true;
}
