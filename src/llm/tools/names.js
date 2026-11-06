/**
 * The names of the agent's tools. Tools are defined with these constants and the system prompt is
 * built from them, so renaming a tool cannot leave the prompt pointing at one that no longer exists.
 */
export const TOOL_NAMES = Object.freeze({
    getOnlineVideoInfo: 'get_online_video_info',
    getLocalMediaInfo: 'get_local_media_info',
    listFormats: 'list_formats',
    downloadVideo: 'download_video',
    downloadAudio: 'download_audio',
    downloadThumbnail: 'download_thumbnail',
    listSubtitles: 'list_subtitles',
    downloadSubtitles: 'download_subtitles',
    downloadWithHardsub: 'download_with_hardsub',
    reencodeMp4: 'reencode_mp4',
    extractAudioFromFile: 'extract_audio_from_file',
    listDownloads: 'list_downloads',
    deleteFiles: 'delete_files'
});
