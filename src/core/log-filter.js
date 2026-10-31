// Rule list for log noise reduction
const LOG_NOISE_PATTERNS = [
    /Opening 'https?:\/\//i,                                // HLS segment download spam
    /Changing ID3 metadata in HLS audio/i,                  // Twitter/X non-fatal metadata warning
    /mime type is not rfc8216 compliant/i,                  // HLS header compliance warning
    /^\s*(Input|Output) #\d+/i,                             // FFmpeg stream probe input/output header
    /^\s*Program \d+/i,                                     // FFmpeg program header
    /^\s*Stream mapping:/i,                                 // FFmpeg stream mapping header
    /^\s*Stream #\d+:\d+/i,                                 // FFmpeg stream descriptor
    /^\s*(Metadata:|variant_bitrate|encoder\s*:)/i,         // FFmpeg metadata tags
    /^\s*(TIT3|id3v2_priv|JSONMetadata|Hydra)/i,            // Twitter HLS ID3 metadata dumps
    /Press \[[q?]\] to stop/i,                              // FFmpeg interactive prompt
    /muxing overhead: unknown/i,                            // FFmpeg muxing summary header
    /^\s*Duration:\s*[\d:.]+/i,                             // FFmpeg stream duration probe header
    /^Extract(?:ing|ed)\s+(?:\d+\s+)?cookies from/i,        // Browser cookie extraction status
    /\[jsc:[^\]]+\]\s+Solving JS challenges/i,              // yt-dlp JS challenge solver status
    /^\[SubtitlesConvertor\]/i                              // yt-dlp internal subtitle convertor messages
];

export function shouldSuppressLogLine(line) {
    return LOG_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

export function isProgressLine(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[download]')) {
        if (trimmed.includes('%') || trimmed.includes('ETA')) {
            return true;
        }
        if (/\s+[\d.]+\s*[kKmMgGtT]?i?B\s+at\s+/i.test(trimmed) || /\bat\s+\S*B\/s/i.test(trimmed)) {
            return true;
        }
        return false;
    }
    if ((/^(?:frame|size)=\s*\S+/i.test(trimmed) && trimmed.includes('time=')) ||
        (/^time=\S+/i.test(trimmed) && trimmed.includes('bitrate='))) {
        return true;
    }
    return false;
}

// Line buffer wrapper to safely handle chunked stream data and filter noise
class LineStreamFilter {
    constructor(onLine) {
        this.buffer = '';
        this.onLine = onLine;
    }

    push(chunk) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split(/\r\n|\r|\n/);
        this.buffer = lines.pop(); // Keep incomplete trailing fragment in buffer

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length > 0 && !shouldSuppressLogLine(trimmed)) {
                this.onLine(line);
            }
        }
    }

    flush() {
        if (this.buffer.length > 0) {
            const trimmed = this.buffer.trim();
            if (trimmed.length > 0 && !shouldSuppressLogLine(trimmed)) {
                this.onLine(this.buffer);
            }
            this.buffer = '';
        }
    }
}

// Helper to attach stdout and stderr line-stream filters to a child process
export function attachLineStreamFilters(child, onLine) {
    const stdoutFilter = new LineStreamFilter(onLine);
    const stderrFilter = new LineStreamFilter(onLine);

    child.stdout.on('data', (data) => stdoutFilter.push(data));
    child.stderr.on('data', (data) => stderrFilter.push(data));

    return () => {
        stdoutFilter.flush();
        stderrFilter.flush();
    };
}
