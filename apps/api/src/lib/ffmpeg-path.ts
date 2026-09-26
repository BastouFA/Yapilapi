import ffmpegStatic from 'ffmpeg-static';

/**
 * The ffmpeg binary to run. FFMPEG_PATH wins when set: the Docker image and CI
 * use the system ffmpeg because the bundled Linux build (ffmpeg-static) has no
 * `drawtext`, which the editor's text and the shared-reel watermark need.
 * Everywhere else the bundled binary is used, so development needs nothing
 * installed.
 */
export const ffmpegPath: string | null = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null);
export default ffmpegPath;
