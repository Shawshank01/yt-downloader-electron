import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { findMediaFile } from '../src/core/media-files.js';
import { probeMedia, summarizeMediaInfo } from '../src/core/ffmpeg.js';
import { getLocalMediaInfo } from '../src/core/tools.js';
import { getTool, getRisk } from '../src/llm/tool-registry.js';
import { runAgent } from '../src/llm/agent.js';
import { ValidationError } from '../src/llm/validate.js';

async function makeFolder(files = {}) {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ytdl-media-test-'));
    for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(join(dir, name), content);
    }
    return dir;
}

test('get_local_media_info declaration and describe', () => {
    const tool = getTool('get_local_media_info');
    assert.ok(tool);
    assert.equal(tool.name, 'get_local_media_info');
    assert.equal(getRisk(tool, {}), 'low');
    assert.equal(tool.describe({ file: 'song.mp3' }), 'Inspect media info for "song.mp3"');
    assert.equal(tool.describe({}), 'Inspect media info for "media"');
    assert.deepEqual(tool.parameters.required, ['file']);
    assert.ok(tool.parameters.properties.file);
});

test('findMediaFile matches exact file, fragment, and picks newest when multiple match', async () => {
    const folder = await makeFolder({
        'clip_old.mp4': 'old',
        'clip_new.mp4': 'new',
        'track.mp3': 'audio',
        'readme.txt': 'text',
        '.hidden.mp4': 'hidden'
    });

    // Stagger mtimes
    const now = Date.now();
    await fs.utimes(join(folder, 'clip_old.mp4'), (now - 10000) / 1000, (now - 10000) / 1000);
    await fs.utimes(join(folder, 'clip_new.mp4'), now / 1000, now / 1000);

    // Exact match
    const exact = await findMediaFile(folder, 'track.mp3');
    assert.equal(exact?.file, 'track.mp3');

    // Substring match resolves to most recent file
    const match = await findMediaFile(folder, 'clip');
    assert.equal(match?.file, 'clip_new.mp4');

    // Case-insensitive substring match
    const caseMatch = await findMediaFile(folder, 'TRACK');
    assert.equal(caseMatch?.file, 'track.mp3');

    // Non-media fallback
    const textMatch = await findMediaFile(folder, 'readme');
    assert.equal(textMatch?.file, 'readme.txt');

    // Missing file returns null
    const missing = await findMediaFile(folder, 'nonexistent');
    assert.equal(missing, null);
});

test('summarizeMediaInfo formats video, audio, and subtitle streams accurately', () => {
    const mockData = {
        format: {
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
            duration: '125.6',
            size: '10485760', // 10 MB
            bit_rate: '667000'
        },
        streams: [
            {
                codec_type: 'video',
                codec_name: 'h264',
                width: 1920,
                height: 1080,
                display_aspect_ratio: '16:9',
                avg_frame_rate: '30/1',
                pix_fmt: 'yuv420p',
                bit_rate: '500000',
                disposition: { attached_pic: 0 }
            },
            {
                codec_type: 'audio',
                codec_name: 'aac',
                channels: 2,
                channel_layout: 'stereo',
                sample_rate: '48000',
                bit_rate: '160000',
                tags: { language: 'eng', title: 'Stereo Track' }
            },
            {
                codec_type: 'subtitle',
                codec_name: 'mov_text',
                tags: { language: 'eng', title: 'English' },
                disposition: { default: 1, forced: 0 }
            }
        ]
    };

    const res = summarizeMediaInfo(mockData, 'sample.mp4');
    assert.equal(res.ok, true);
    assert.equal(res.file, 'sample.mp4');
    assert.equal(res.format, 'mov,mp4,m4a,3gp,3g2,mj2');
    assert.equal(res.duration, '02:06');
    assert.equal(res.duration_seconds, 125.6);
    assert.equal(res.size_mb, 10);
    assert.equal(res.bit_rate_kbps, 667);

    assert.deepEqual(res.video, {
        codec: 'h264',
        width: 1920,
        height: 1080,
        resolution: '1920x1080',
        aspect_ratio: '16:9',
        fps: 30,
        pixel_format: 'yuv420p',
        bit_rate_kbps: 500
    });

    assert.deepEqual(res.audio, {
        codec: 'aac',
        channels: 2,
        channel_layout: 'stereo',
        sample_rate_hz: 48000,
        bit_rate_kbps: 160,
        language: 'eng',
        title: 'Stereo Track'
    });

    assert.equal(res.subtitle_streams?.length, 1);
    assert.equal(res.subtitle_streams[0].language, 'eng');
    assert.equal(res.subtitle_streams[0].is_default, true);
});

test('summarizeMediaInfo distinguishes cover art from video stream and handles audio-only files', () => {
    const audioOnlyWithCover = {
        format: {
            format_name: 'mp3',
            duration: '3661.2',
            size: '52428800',
            bit_rate: '128000'
        },
        streams: [
            {
                codec_type: 'audio',
                codec_name: 'mp3',
                channels: 2,
                channel_layout: 'stereo',
                sample_rate: '44100',
                bit_rate: '128000'
            },
            {
                codec_type: 'video',
                codec_name: 'mjpeg',
                width: 500,
                height: 500,
                disposition: { attached_pic: 1 }
            }
        ]
    };

    const res = summarizeMediaInfo(audioOnlyWithCover, 'album.mp3');
    assert.equal(res.duration, '01:01:01');
    assert.equal(res.audio?.codec, 'mp3');
    // The main video is the attached cover art because no other video exists, but is marked as attached_pic
    assert.equal(res.video?.is_attached_pic, true);
    assert.equal(res.video?.codec, 'mjpeg');
});

test('summarizeMediaInfo handles empty or missing metadata safely', () => {
    const empty = summarizeMediaInfo({}, 'unknown.bin');
    assert.equal(empty.ok, true);
    assert.equal(empty.duration, null);
    assert.equal(empty.duration_seconds, null);
    assert.equal(empty.size_mb, null);
    assert.equal(empty.video, null);
    assert.equal(empty.audio, null);
});

test('probeMedia and getLocalMediaInfo report error on missing or invalid file', async () => {
    const folder = await makeFolder({ 'not_media.txt': 'just plain text' });

    // Missing file in folder
    const missingRes = await getLocalMediaInfo(folder, 'missing.mp4');
    assert.equal(missingRes.ok, false);
    assert.match(missingRes.error, /No matching media file found/);

    // Invalid non-media file probed with ffprobe
    const invalidRes = await probeMedia(join(folder, 'not_media.txt'));
    assert.equal(invalidRes.ok, false);
    assert.ok(invalidRes.error);
});

test('probeMedia inspects a real media file with ffprobe', async () => {
    const dir = await makeFolder({});
    const testAudio = join(dir, 'test_sample.mp3');

    // Create a 0.5s audio file with silence using ffmpeg
    const create = spawnSync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', '0.5',
        '-c:a', 'libmp3lame',
        testAudio
    ]);

    if (create.status !== 0) {
        // Skip if ffmpeg cannot generate audio in this environment
        return;
    }

    const res = await getLocalMediaInfo(dir, 'test_sample');
    assert.equal(res.ok, true);
    assert.equal(res.file, 'test_sample.mp3');
    assert.equal(res.audio?.codec, 'mp3');
    assert.equal(res.audio?.channels, 2);
    assert.equal(res.audio?.sample_rate_hz, 44100);
});

test('agent runs get_local_media_info and tool rejects path traversal', async () => {
    const folder = await makeFolder({ 'song.mp3': 'data' });
    const tool = getTool('get_local_media_info');

    // Path traversal attempt should throw ValidationError
    await assert.rejects(
        () => tool.run({ file: '../etc/passwd' }, { downloadFolder: folder }),
        ValidationError
    );

    // Agent executes get_local_media_info turn
    const provider = {
        id: 'scripted',
        async chat({ messages }) {
            const last = messages.at(-1);
            if (last.role === 'tool') {
                return { text: `Duration is ${last.result.error || 'inspected'}`, toolCalls: [] };
            }
            return {
                text: '',
                toolCalls: [{ id: 'call-1', name: 'get_local_media_info', args: { file: 'song.mp3' } }]
            };
        }
    };

    const res = await runAgent({
        provider,
        system: '',
        history: [],
        userText: 'Check song.mp3',
        ctx: { downloadFolder: folder }
    });

    assert.ok(res.text.includes('Duration is'));
});

test('get_local_media_info handles missing file argument gracefully', async () => {
    const emptyFolder = await makeFolder({});
    const tool = getTool('get_local_media_info');

    // When folder has no media files and args.file is omitted, returns error object without throwing
    const emptyRes = await tool.run({}, { downloadFolder: emptyFolder });
    assert.equal(emptyRes.ok, false);
    assert.match(emptyRes.error, /Please specify which file/);

    // When folder has a media file and args.file is omitted, falls back to probing that file
    const folderWithMedia = await makeFolder({ 'clip.mp4': 'dummy' });
    const probeRes = await tool.run({}, { downloadFolder: folderWithMedia });
    // Probing dummy file fails ffprobe, but it successfully resolved clip.mp4 rather than throwing "file must be a string"
    assert.equal(probeRes.ok, false);
    assert.notEqual(probeRes.error, '"file" must be a string.');
});
