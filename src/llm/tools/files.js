// Tools that look at or delete files in the download folder.
import { promises as fs } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { VIDEO_EXTENSIONS } from '../../core/media-files.js';
import { requireFolder } from '../context.js';
import { MAX_DELETE_FILES, MAX_LISTED_FILES } from '../limits.js';
import { ValidationError, validateFileHint } from '../validate.js';
import { TOOL_NAMES } from './names.js';
import { defineTool } from './common.js';

const BYTES_PER_MB = 1024 * 1024;

/** Stat every regular, non-hidden file of `folder`; files that vanish meanwhile are skipped. */
async function statFiles(folder, entries) {
    const stats = await Promise.all(
        entries
            .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
            .map(async (entry) => {
                try {
                    return { name: entry.name, stat: await fs.stat(join(folder, entry.name)) };
                } catch {
                    return null;
                }
            })
    );
    return stats.filter(Boolean);
}

/**
 * The full path of `name` inside `folder`, or null if it would be anywhere else. This is a second
 * line of defence behind validateFileHint: whatever the name contains, only direct children of the
 * download folder can ever be touched.
 */
export function resolveInFolder(folder, name) {
    const root = resolve(folder);
    const full = resolve(root, name);
    return dirname(full) === root ? full : null;
}

export const fileTools = [
    defineTool({
        name: TOOL_NAMES.listDownloads,
        description:
            'List the most recent files in the download folder (name, size, modified time). Use it to find exact file names before re-encoding or deleting.',
        describe: () => 'List files in the download folder',
        async run(_args, ctx) {
            const folder = requireFolder(ctx);
            let entries;
            try {
                entries = await fs.readdir(folder, { withFileTypes: true });
            } catch (e) {
                return { ok: false, error: `Cannot read the download folder: ${e.message}` };
            }
            const files = (await statFiles(folder, entries)).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
            const shown = files.slice(0, MAX_LISTED_FILES).map(({ name, stat }) => ({
                name,
                size_mb: Math.round((stat.size / BYTES_PER_MB) * 10) / 10,
                modified: new Date(stat.mtimeMs).toISOString(),
                is_video: VIDEO_EXTENSIONS.includes(extname(name).toLowerCase())
            }));
            return { ok: true, folder, total_files: files.length, files: shown };
        }
    }),
    defineTool({
        name: TOOL_NAMES.deleteFiles,
        description:
            'Delete files from the download folder by exact file name (e.g. leftover temporary files reported by another tool). Only deletes regular files inside the download folder.',
        risk: 'high',
        properties: {
            files: {
                type: 'array',
                items: { type: 'string' },
                description: `Exact file names (max ${MAX_DELETE_FILES}), as reported by list_downloads or other tools.`
            }
        },
        required: ['files'],
        describe: (a) => `Delete ${Array.isArray(a.files) ? a.files.length : '?'} file(s): ${Array.isArray(a.files) ? a.files.join(', ') : ''
            }`,
        async run(args, ctx) {
            const folder = requireFolder(ctx);
            if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > MAX_DELETE_FILES) {
                throw new ValidationError(`"files" must be a list of 1 to ${MAX_DELETE_FILES} file names.`);
            }
            const names = args.files.map((f) => validateFileHint(f, 'files[]'));
            const deleted = [];
            const skipped = [];
            for (const name of names) {
                const full = resolveInFolder(folder, name);
                if (!full) {
                    skipped.push(`${name} (outside the download folder)`);
                    continue;
                }
                try {
                    const stat = await fs.lstat(full);
                    if (!stat.isFile()) {
                        skipped.push(`${name} (not a regular file)`);
                        continue;
                    }
                    await fs.unlink(full);
                    deleted.push(name);
                } catch (e) {
                    skipped.push(`${name} (${e.code === 'ENOENT' ? 'not found' : e.message})`);
                }
            }
            return { ok: true, deleted, skipped };
        }
    })
];
