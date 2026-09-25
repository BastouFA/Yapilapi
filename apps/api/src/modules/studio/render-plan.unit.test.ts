import { describe, expect, it } from 'vitest';
import { emptyEdl, type Edl } from './edl.js';
import {
  buildRenderArgs,
  cropRect,
  filterPath,
  silenceDetectArgs,
  thumbnailArgs,
} from './render-plan.js';

const probe = { durationMs: 10_000, width: 1920, height: 1080, hasVideo: true, hasAudio: true };
const plan = (edl: Edl, over: Partial<Parameters<typeof buildRenderArgs>[0]> = {}) =>
  buildRenderArgs({
    edl,
    source: probe,
    inputPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    ...over,
  });

describe('crop geometry', () => {
  it('crops landscape to portrait, square and 4:5 with even sizes inside the frame', () => {
    expect(cropRect(1920, 1080, '9:16')).toEqual({ w: 606, h: 1080, x: 656, y: 0 });
    expect(cropRect(1920, 1080, '1:1')).toEqual({ w: 1080, h: 1080, x: 420, y: 0 });
    expect(cropRect(1920, 1080, '16:9')).toEqual({ w: 1920, h: 1080, x: 0, y: 0 });
    const tall = cropRect(1080, 1920, '16:9');
    expect(tall).toEqual({ w: 1080, h: 606, x: 0, y: 656 });
    for (const r of [
      cropRect(641, 479, '1:1'),
      cropRect(333, 777, '4:5'),
      cropRect(64, 48, '9:16'),
    ]) {
      expect((r.w % 2) + (r.h % 2) + (r.x % 2) + (r.y % 2)).toBe(0);
    }
  });
  it('cropX moves the window and never leaves the frame', () => {
    expect(cropRect(1920, 1080, '1:1', 0).x).toBe(0);
    expect(cropRect(1920, 1080, '1:1', 1).x).toBe(840);
    expect(cropRect(1920, 1080, '1:1', 5).x).toBe(840);
  });
});

describe('ffmpeg argument construction', () => {
  it('concatenates kept segments with trim/atrim and never mentions the output as an input', () => {
    const { args, graph } = plan({
      ...emptyEdl(),
      segments: [
        { startMs: 1000, endMs: 3000 },
        { startMs: 5000, endMs: 6500 },
      ],
    });
    expect(graph).toContain('[0:v:0]trim=start=1.000:end=3.000,setpts=PTS-STARTPTS[v0]');
    expect(graph).toContain('[0:a:0]atrim=start=5.000:end=6.500,asetpts=PTS-STARTPTS[a1]');
    expect(graph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]');
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/tmp/in.mp4']);
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    expect(args).toEqual(
      expect.arrayContaining([
        '-protocol_whitelist',
        'file',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
      ]),
    );
  });
  it('whole source when there are no segments; crop and burn-in in the right order; never upscales', () => {
    const { graph } = plan(
      { ...emptyEdl(), aspect: '9:16', captions: { lang: 'en', burnIn: true } },
      { subtitlesPath: "/tmp/we ird:dir/sub's.srt" },
    );
    expect(graph).toContain('trim=start=0.000:end=10.000');
    const vout = graph.split(';').find((p) => p.endsWith('[vout]'))!;
    expect(vout.indexOf('crop=606:1080:656:0')).toBeGreaterThan(-1);
    expect(vout.indexOf('subtitles=')).toBeGreaterThan(vout.indexOf('crop='));
    expect(vout.indexOf("scale=-2:'min(1080,ih)'")).toBeGreaterThan(vout.indexOf('subtitles='));
    expect(vout).toContain("subtitles=/tmp/we ird\\:dir/sub\\'s.srt");
  });
  it('sidecar captions do not add a subtitles filter; audio-only and video-only sources produce matching graphs', () => {
    expect(
      plan(
        { ...emptyEdl(), captions: { lang: 'en', burnIn: false } },
        { subtitlesPath: '/tmp/x.srt' },
      ).graph,
    ).not.toContain('subtitles');
    const audioOnly = buildRenderArgs({
      edl: emptyEdl(),
      source: { ...probe, hasVideo: false, width: null, height: null },
      inputPath: '/i.m4a',
      outputPath: '/o.m4a',
    });
    expect(audioOnly.graph).toBe(
      '[0:a:0]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS[a0];[a0]concat=n=1:v=0:a=1[ac]',
    );
    expect(audioOnly.args).not.toContain('libx264');
    const silent = buildRenderArgs({
      edl: emptyEdl(),
      source: { ...probe, hasAudio: false },
      inputPath: '/i.mp4',
      outputPath: '/o.mp4',
    });
    expect(silent.graph).not.toContain('atrim');
    expect(silent.args).not.toContain('aac');
  });
  it('forces the demuxer chosen by our sniffing and escapes filter paths', () => {
    expect(plan(emptyEdl(), { demuxer: 'mov,mp4,m4a,3gp,3g2,mj2' }).args.join(' ')).toContain(
      '-f mov,mp4,m4a,3gp,3g2,mj2 -i /tmp/in.mp4',
    );
    expect(filterPath('C:\\a b\\c[1].srt')).toBe('C\\:/a b/c\\[1\\].srt');
  });
  it('thumbnail and silence detection arguments', () => {
    expect(thumbnailArgs('/o.mp4', 1500, '/t.jpg')).toEqual(
      expect.arrayContaining(['-ss', '1.500', '-frames:v', '1']),
    );
    const s = silenceDetectArgs('/i.mp4', undefined);
    expect(s).toContain('silencedetect=noise=-35dB:d=0.6');
    expect(s).toContain('-vn');
  });
});
