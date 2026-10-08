import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VOICE_CLIPS_PER_HOUR, VOICE_PEAKS, YAPS_PER_HOUR } from '@yapilapi/shared';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import { loadTranslatables } from '../src/lib/translation.ts';
import type { TranscriptionProvider } from '../src/lib/transcription.ts';
import type { SpeechProvider } from '../src/lib/speech.ts';
import type { AiProvider } from '../src/lib/ai/providers.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, followAccepted, jobRunner, signUp, testApp, type JobRunner, type TestUser } from './helpers.ts';

/**
 * Yaps (docs/product/yaps.md): voice posts of up to a minute, voice replies and voice intros.
 * Recordings are measured and stored small by the server, attached once, transcribed through a
 * stand-in speech-to-text provider (or 'unavailable' without one), checked like post text, kept
 * out of suggestions until then, translated for readers who can hear them, counted by listening,
 * exported and deleted.
 */

/** A translation model that answers "EN: <text>". */
const translator: AiProvider = {
  name: 'stub',
  model: 'stub-1',
  complete: async ({ prompt }) => ({ text: `EN: ${prompt}`, provider: 'stub', model: 'stub-1' }),
};
/** Text-to-speech that says what it's given. */
const tts: SpeechProvider = {
  name: 'stub-tts',
  model: 'stub-voice-1',
  voiceFor: () => 'alloy',
  synthesize: async ({ text }) => ({ audio: Buffer.from(`ID3 spoken:${text}`), mime: 'audio/mpeg', ext: 'mp3' }),
};

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp({}, { translator });
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  t.ctx.transcription = null;
  // Fair starts given here would take slots in other files' feeds.
  await t.ctx.db.query(`UPDATE fair_start_reels SET status = 'stopped', finished_at = now() WHERE status = 'active'`);
  await t.close();
});

const db = () => t.ctx.db;

/** A tone of the given length: m4a (as the phone records) or webm/opus (as browsers record). */
const tones = new Map<string, Buffer>();
function tone(seconds: number, format: 'm4a' | 'webm' = 'm4a'): Buffer {
  const key = `${seconds}:${format}`;
  if (tones.has(key)) return tones.get(key)!;
  const dir = mkdtempSync(path.join(tmpdir(), 'ypl-yap-'));
  try {
    const out = path.join(dir, `tone.${format}`);
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=330:duration=${seconds}`,
      ...(format === 'webm' ? ['-c:a', 'libopus', '-b:a', '48k'] : ['-c:a', 'aac', '-b:a', '64k']),
      out,
    ]);
    const buf = readFileSync(out);
    tones.set(key, buf);
    return buf;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function upload(u: TestUser, data: Buffer, purpose = 'yap', mime = 'audio/mp4', name = 'voice.m4a') {
  const boundary = '----yp' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/voice?purpose=${purpose}`,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  return { status: res.statusCode, body: res.json() };
}

async function clip(u: TestUser, seconds = 2, purpose = 'yap') {
  const r = await upload(u, tone(seconds), purpose);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.voice as { id: string; url: string; durationMs: number; peaks: number[]; transcript: { status: string; text: string | null } };
}

const yap = (u: TestUser, v: { id: string; url: string }, extra: Record<string, unknown> = {}) =>
  as(t.app, u).post('/v1/posts', { format: 'yap', visibility: 'public', body: '', media: [{ id: v.id, url: v.url, kind: 'audio' }], ...extra });

const drain = async () => {
  for (let i = 0; i < 20; i++) if (!(await runJobs(t.ctx.jobs))) break;
};

/** A stand-in speech-to-text provider that says what it's given to say. */
function provider(say: () => string): TranscriptionProvider & { calls: number } {
  const p = {
    name: 'stub',
    calls: 0,
    async transcribe() {
      p.calls++;
      return say();
    },
  };
  return p;
}

const vtt = (...lines: string[]) => `WEBVTT\n\n${lines.map((l, i) => `00:0${i}.000 --> 00:0${i}.900\n${l}`).join('\n\n')}\n`;

/** An account that may have a fair start (adult, public, confirmed email). */
async function creator() {
  const u = await signUp(t.app);
  await db().query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [u.id]);
  return u;
}
const fairStart = async (postId: string) => (await db().query(`SELECT status FROM fair_start_reels WHERE post_id = $1`, [postId])).rows[0]?.status ?? null;
const yapsFeed = async (u: TestUser) => ((await as(t.app, u).get('/v1/feed?mode=yaps&limit=50')).body.items as { id: string }[]).map((p) => p.id);

describe('recording', () => {
  it('measures, stores small and draws a waveform, whatever the app recorded with', async () => {
    const u = await signUp(t.app);
    const m4a = await upload(u, tone(3));
    expect(m4a.status).toBe(201);
    expect(m4a.body.voice).toMatchObject({ durationMs: expect.any(Number), transcript: { status: 'pending', text: null, segments: [] } });
    expect(Math.abs(m4a.body.voice.durationMs - 3000)).toBeLessThan(150);
    expect(m4a.body.voice.peaks).toHaveLength(VOICE_PEAKS);
    expect(Math.max(...m4a.body.voice.peaks)).toBe(100);
    const stored = (await db().query(`SELECT mime, size_bytes, kind FROM media WHERE id = $1`, [m4a.body.voice.id])).rows[0];
    // Mono AAC at about 32 kbit/s: 3 seconds stays well under 20 KB.
    expect(stored).toMatchObject({ mime: 'audio/mp4', kind: 'audio' });
    expect(stored.size_bytes).toBeLessThan(20_000);

    const webm = await upload(u, tone(2, 'webm'), 'comment', 'audio/webm', 'voice.weba');
    expect(webm.status).toBe(201);
    expect(Math.abs(webm.body.voice.durationMs - 2000)).toBeLessThan(150);
  });

  it('is a second to a minute, an intro up to 15 seconds, and only a recording', async () => {
    const u = await signUp(t.app);
    const short = await upload(u, tone(0.5));
    expect(short.status).toBe(400);
    expect(short.body.error.message).toBe('This recording is too short.');
    const long = await upload(u, tone(62));
    expect(long.status).toBe(400);
    expect(long.body.error.message).toBe('Yaps and voice replies can be up to a minute.');
    expect((await upload(u, tone(16), 'intro')).body.error.message).toBe('A voice intro can be up to 15 seconds.');
    expect((await upload(u, tone(16), 'comment')).status).toBe(201);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const notAudio = await upload(u, png, 'yap', 'image/png', 'x.png');
    expect(notAudio.status).toBe(415);
    expect((await as(t.app, null).post('/v1/voice', {})).status).toBe(401);
  }, 60_000);

  it('goes at a sensible pace', async () => {
    const u = await signUp(t.app);
    await db().query(
      `WITH m AS (INSERT INTO media (owner_id, kind, url, status) SELECT $1, 'audio', 'http://localhost/media/x.m4a', 'ready' FROM generate_series(1, $2) RETURNING id)
       INSERT INTO voice_clips (media_id, owner_id, purpose, duration_ms) SELECT id, $1, 'yap', 1000 FROM m`,
      [u.id, VOICE_CLIPS_PER_HOUR],
    );
    const r = await upload(u, tone(2));
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('slow_down');
  });
});

describe('posting a Yap', () => {
  it('is a post with its recording, waveform and transcript state, in its author’s feeds', async () => {
    t.ctx.transcription = null;
    const u = await signUp(t.app);
    const v = await clip(u, 2);
    const r = await yap(u, v, { body: '[Dev data] Morning from Lagos #mornings' });
    expect(r.status).toBe(201);
    expect(r.body.post).toMatchObject({ format: 'yap', kind: 'audio', topics: ['mornings'] });
    expect(r.body.post.voice).toMatchObject({ id: v.id, url: v.url, durationMs: v.durationMs, peaks: v.peaks });
    // Without speech-to-text: "Transcript not available", at once.
    expect(r.body.post.voice.transcript.status).toBe('unavailable');
    const other = await signUp(t.app);
    expect((await as(t.app, other).get(`/v1/posts/${r.body.post.id}`)).body.post.voice.id).toBe(v.id);
    expect((await as(t.app, other).get(`/v1/voice/${v.id}`)).body.voice.transcript.status).toBe('unavailable');
    expect(await yapsFeed(other)).toContain(r.body.post.id);
    expect((await as(t.app, u).get(`/v1/users/${u.username}/posts`)).body.items.map((p: { id: string }) => p.id)).toContain(r.body.post.id);
  });

  it('takes one recording made for a Yap, once, and a short line of words', async () => {
    const u = await signUp(t.app);
    const v = await clip(u);
    expect((await yap(u, v)).status).toBe(201);
    const again = await yap(u, v);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('That recording was already used. Record a new one.');
    const reply = await clip(u, 2, 'comment');
    expect((await yap(u, reply)).body.error.message).toBe('That recording was made for something else. Record it again here.');
    // Someone else's recording isn't yours to post.
    const theirs = await clip(await signUp(t.app));
    expect((await yap(u, theirs)).status).toBe(404);
    const none = await as(t.app, u).post('/v1/posts', { format: 'yap', visibility: 'public', body: 'Just words', media: [] });
    expect(none.status).toBe(400);
    expect(none.body.error.details.fields.media).toBe('A Yap is one voice recording.');
    const v2 = await clip(u);
    const wordy = await yap(u, v2, { body: 'x'.repeat(281) });
    expect(wordy.body.error.details.fields.body).toBe('The words with a Yap can be up to 280 characters.');
    const ok = await yap(u, v2, { body: 'x'.repeat(280) });
    expect(ok.status).toBe(201);
    const edit = await as(t.app, u).patch(`/v1/posts/${ok.body.post.id}`, { body: 'y'.repeat(300) });
    expect(edit.status).toBe(400);
  });

  it('reaches only its audience: followers, a squad, and nobody who blocked or was blocked', async () => {
    t.ctx.transcription = null;
    const ada = await signUp(t.app);
    const fan = await signUp(t.app);
    const stranger = await signUp(t.app);
    const mate = await signUp(t.app);
    await followAccepted(t.app, fan, ada);
    const followers = await yap(ada, await clip(ada), { visibility: 'followers' });
    const id = followers.body.post.id as string;
    const voiceId = followers.body.post.voice.id as string;
    expect((await as(t.app, fan).get(`/v1/posts/${id}`)).status).toBe(200);
    expect((await as(t.app, stranger).get(`/v1/posts/${id}`)).status).toBe(404);
    expect((await as(t.app, stranger).get(`/v1/voice/${voiceId}`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/voice/${voiceId}`)).status).toBe(404);

    const squad = (await db().query(`INSERT INTO squads (owner_id, name) VALUES ($1, '[Dev data] Crew') RETURNING id`, [ada.id])).rows[0].id;
    await db().query(`INSERT INTO squad_members (squad_id, user_id, role, status) VALUES ($1,$2,'owner','active'), ($1,$3,'member','active')`, [
      squad,
      ada.id,
      mate.id,
    ]);
    const sq = await yap(ada, await clip(ada), { visibility: 'squad', squadId: squad });
    expect(sq.status).toBe(201);
    expect((await as(t.app, mate).get(`/v1/posts/${sq.body.post.id}`)).body.post.squad.id).toBe(squad);
    expect((await as(t.app, fan).get(`/v1/posts/${sq.body.post.id}`)).status).toBe(404);
    expect((await as(t.app, fan).get(`/v1/voice/${sq.body.post.voice.id}`)).status).toBe(404);
    expect(await yapsFeed(fan)).not.toContain(sq.body.post.id);

    await as(t.app, ada).post(`/v1/users/${fan.id}/block`);
    expect((await as(t.app, fan).get(`/v1/posts/${id}`)).status).toBe(404);
    expect((await as(t.app, fan).get(`/v1/voice/${voiceId}`)).status).toBe(404);
  });

  it('can be found by what it says', async () => {
    const u = await signUp(t.app);
    t.ctx.transcription = provider(() => vtt('Zanzibarquest is my favourite beach'));
    try {
      const r = await yap(u, await clip(u));
      await drain();
      const found = await as(t.app, await signUp(t.app)).get('/v1/search?q=zanzibarquest&type=posts');
      expect(found.status).toBe(200);
      expect(found.body.results.posts.map((p: { id: string }) => p.id)).toContain(r.body.post.id);
    } finally {
      t.ctx.transcription = null;
    }
  });

  it('goes at a sensible pace', async () => {
    const u = await signUp(t.app);
    await db().query(`INSERT INTO posts (author_id, kind, format, body, visibility) SELECT $1, 'audio', 'yap', '', 'public' FROM generate_series(1, $2)`, [
      u.id,
      YAPS_PER_HOUR,
    ]);
    const r = await yap(u, await clip(u));
    expect(r.status).toBe(429);
    expect(r.body.error.message).toBe('You’ve posted a lot of Yaps in the last hour. Try again later.');
  });

  it('is behind the YAPS flag', async () => {
    const u = await signUp(t.app);
    const v = await clip(u);
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('YAPS', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    try {
      expect((await upload(u, tone(2))).body.error.code).toBe('feature_disabled');
      expect((await yap(u, v)).body.error.code).toBe('feature_disabled');
      expect((await as(t.app, u).get('/v1/feed?mode=yaps')).status).toBe(404);
    } finally {
      await db().query(`DELETE FROM feature_flags WHERE key = 'YAPS'`);
    }
    expect((await yap(u, v)).status).toBe(201);
  });
});

describe('transcripts', () => {
  it('are made through the provider, with timed lines and their language, and the Yap is suggested once they passed', async () => {
    const stub = provider(() => vtt('Good morning everyone, the market opens early today.', 'Come and see the new fabrics.'));
    t.ctx.transcription = stub;
    try {
      const ada = await creator();
      const fan = await signUp(t.app);
      const stranger = await signUp(t.app);
      await followAccepted(t.app, fan, ada);
      const r = await yap(ada, await clip(ada, 2));
      expect(r.status).toBe(201);
      const id = r.body.post.id as string;
      expect(r.body.post.voice.transcript.status).toBe('pending');
      // Waiting for its words: followers have it, nobody else is suggested it, and no fair start yet.
      expect(await yapsFeed(fan)).toContain(id);
      expect(await yapsFeed(stranger)).not.toContain(id);
      expect((await as(t.app, stranger).get('/v1/feed?mode=for_you&limit=50')).body.items.map((p: { id: string }) => p.id)).not.toContain(id);
      expect(await fairStart(id)).toBeNull();
      // Anyone who opens it still can.
      expect((await as(t.app, stranger).get(`/v1/posts/${id}`)).status).toBe(200);

      await drain();
      expect(stub.calls).toBe(1);
      const voice = (await as(t.app, stranger).get(`/v1/voice/${r.body.post.voice.id}`)).body.voice;
      expect(voice.transcript).toEqual({
        status: 'ready',
        text: 'Good morning everyone, the market opens early today. Come and see the new fabrics.',
        lang: 'en',
        segments: [
          { start: 0, end: 0.9, text: 'Good morning everyone, the market opens early today.' },
          { start: 1, end: 1.9, text: 'Come and see the new fabrics.' },
        ],
      });
      expect(await yapsFeed(stranger)).toContain(id);
      expect(await fairStart(id)).toBe('active');
    } finally {
      t.ctx.transcription = null;
    }
  });

  it('are checked like a post’s words: a Yap that says something it shouldn’t is held, and never suggested', async () => {
    t.ctx.transcription = provider(() => vtt('Buy followers here, cheap followers for everyone'));
    try {
      const ada = await creator();
      const stranger = await signUp(t.app);
      const r = await yap(ada, await clip(ada));
      const id = r.body.post.id as string;
      await drain();
      const post = (await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [id])).rows[0];
      expect(post.moderation_status).toBe('restricted');
      const kase = (await db().query(`SELECT source, risk, signals FROM moderation_cases WHERE target_type = 'post' AND target_id = $1`, [id])).rows[0];
      expect(kase).toMatchObject({ source: 'automated', risk: 'restrict' });
      expect(kase.signals.signals).toEqual(expect.arrayContaining(['spam_scam', 'voice_transcript']));
      expect(await fairStart(id)).toBeNull();
      expect(await yapsFeed(stranger)).not.toContain(id);
      expect((await as(t.app, stranger).get(`/v1/posts/${id}`)).status).toBe(404);
      // The author still sees it.
      expect((await as(t.app, ada).get(`/v1/posts/${id}`)).status).toBe(200);
    } finally {
      t.ctx.transcription = null;
    }
  });

  it('say so when the provider hears nothing or fails, and the Yap goes on', async () => {
    const ada = await creator();
    t.ctx.transcription = provider(() => 'WEBVTT\n\n');
    try {
      const silent = await yap(ada, await clip(ada));
      await drain();
      expect((await as(t.app, ada).get(`/v1/voice/${silent.body.post.voice.id}`)).body.voice.transcript.status).toBe('failed');
      expect(await fairStart(silent.body.post.id)).toBe('active');
      await db().query(`UPDATE fair_start_reels SET status = 'done' WHERE author_id = $1`, [ada.id]);
      t.ctx.transcription = provider(() => {
        throw new Error('Transcription service returned 500');
      });
      const broken = await yap(ada, await clip(ada));
      await drain();
      expect((await as(t.app, ada).get(`/v1/voice/${broken.body.post.voice.id}`)).body.voice.transcript.status).toBe('failed');
    } finally {
      t.ctx.transcription = null;
    }
  });

  it('without speech-to-text, are unavailable and the Yap gets its fair start at once', async () => {
    t.ctx.transcription = null;
    const ada = await creator();
    const r = await yap(ada, await clip(ada));
    expect(r.body.post.voice.transcript.status).toBe('unavailable');
    expect(await fairStart(r.body.post.id)).toBe('active');
  });

  it('are translated only for people who can hear the recording', async () => {
    t.ctx.transcription = provider(() => vtt('Bonjour à tous, quelle belle journée au marché avec mes amis'));
    try {
      const ada = await signUp(t.app);
      const fan = await signUp(t.app);
      const stranger = await signUp(t.app);
      await followAccepted(t.app, fan, ada);
      const r = await yap(ada, await clip(ada), { visibility: 'followers' });
      const voiceId = r.body.post.voice.id as string;
      // Nothing to translate before the words are there.
      expect(await loadTranslatables(db(), fan.id, 'voice', [voiceId])).toEqual([]);
      await drain();
      expect(await loadTranslatables(db(), fan.id, 'voice', [voiceId])).toEqual([
        { kind: 'voice', id: voiceId, text: 'Bonjour à tous, quelle belle journée au marché avec mes amis', lang: 'fr' },
      ]);
      expect(await loadTranslatables(db(), stranger.id, 'voice', [voiceId])).toEqual([]);
      const asked = await as(t.app, stranger).post('/v1/translations', { target: 'en', items: [{ kind: 'voice', id: voiceId }] });
      expect(asked.status).toBe(200);
      expect(asked.body.items).toEqual([]);
      const read = await as(t.app, fan).post('/v1/translations', { target: 'en', items: [{ kind: 'voice', id: voiceId }] });
      expect(read.body.items).toEqual([
        expect.objectContaining({ kind: 'voice', id: voiceId, sourceLanguage: 'fr', text: expect.stringMatching(/^EN: Bonjour/) }),
      ]);

      // "Listen in English": the translation read out, for people who can hear the Yap.
      t.ctx.speech = null;
      expect((await as(t.app, fan).post(`/v1/voice/${voiceId}/speech`, { target: 'en' })).status).toBe(503);
      t.ctx.speech = tts;
      const heard = await as(t.app, fan).post(`/v1/voice/${voiceId}/speech`, { target: 'en' });
      expect(heard.status).toBe(200);
      expect(heard.body).toMatchObject({ language: 'en', url: expect.stringMatching(/^http/) });
      expect((await as(t.app, stranger).post(`/v1/voice/${voiceId}/speech`, { target: 'en' })).status).toBe(404);
      expect((await as(t.app, fan).post(`/v1/voice/${voiceId}/speech`, { target: 'fr' })).status).toBe(400);
      expect((await db().query(`SELECT 1 FROM speech_clip_uses WHERE kind = 'voice' AND item_id = $1`, [voiceId])).rowCount).toBe(1);
    } finally {
      t.ctx.transcription = null;
      t.ctx.speech = null;
    }
  });
});

describe('talking back', () => {
  it('a voice reply, with or without words, in a thread that mixes voice and text; the author hears about it', async () => {
    t.ctx.transcription = null;
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const post = (await yap(ada, await clip(ada))).body.post;
    const text = await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { body: 'Love this' });
    expect(text.status).toBe(201);
    const reply = await clip(bola, 2, 'comment');
    const voiced = await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { voiceId: reply.id, parentId: text.body.comment.id });
    expect(voiced.status).toBe(201);
    expect(voiced.body.comment).toMatchObject({ body: '', parentId: text.body.comment.id, voice: { id: reply.id, durationMs: reply.durationMs } });
    expect(voiced.body.comment.voice.transcript.status).toBe('unavailable');
    const thread = await as(t.app, ada).get(`/v1/comments/${text.body.comment.id}/replies`);
    expect(thread.body.items[0].voice.id).toBe(reply.id);
    const notes = (await as(t.app, ada).get('/v1/notifications')).body.items as { type: string; data?: { commentId?: string } }[];
    expect(notes.some((n) => n.type === 'post_comment' && n.data?.commentId === voiced.body.comment.id)).toBe(true);

    // Neither words nor a recording: nothing to post. A recording goes on one comment, and must be one made for replies.
    expect((await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { body: '' })).body.error.details.fields.body).toBe('Write a comment or record one.');
    expect((await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { voiceId: reply.id })).status).toBe(409);
    expect((await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { voiceId: (await clip(bola)).id })).status).toBe(400);
  });

  it('transcribes and checks a voice reply like a comment’s words', async () => {
    t.ctx.transcription = provider(() => vtt('You are such an idiot'));
    try {
      const ada = await signUp(t.app);
      const bola = await signUp(t.app);
      const post = (await as(t.app, ada).post('/v1/posts', { body: '[Dev data] Any post can be answered by voice', visibility: 'public' })).body.post;
      const reply = await clip(bola, 2, 'comment');
      const c = await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { voiceId: reply.id });
      await drain();
      expect((await db().query(`SELECT moderation_status FROM comments WHERE id = $1`, [c.body.comment.id])).rows[0].moderation_status).toBe('review');
      expect((await as(t.app, ada).get(`/v1/voice/${reply.id}`)).body.voice.transcript.text).toBe('You are such an idiot');
    } finally {
      t.ctx.transcription = null;
    }
  });

  it('deleting a voice reply deletes its recording', async () => {
    const ada = await signUp(t.app);
    const post = (await yap(ada, await clip(ada))).body.post;
    const reply = await clip(ada, 2, 'comment');
    const c = await as(t.app, ada).post(`/v1/posts/${post.id}/comments`, { voiceId: reply.id });
    const key = (await db().query(`SELECT storage_key FROM media WHERE id = $1`, [reply.id])).rows[0].storage_key as string;
    expect(existsSync(path.join('/tmp/ypl-test-uploads', key))).toBe(true);
    expect((await as(t.app, ada).del(`/v1/comments/${c.body.comment.id}`)).status).toBe(200);
    expect((await db().query(`SELECT 1 FROM media WHERE id = $1`, [reply.id])).rowCount).toBe(0);
    expect(existsSync(path.join('/tmp/ypl-test-uploads', key))).toBe(false);
  });
});

describe('voice intro', () => {
  it('is set, heard from the profile, replaced (the old one deleted) and removed', async () => {
    t.ctx.transcription = null;
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const first = await clip(ada, 5, 'intro');
    const set = await as(t.app, ada).patch('/v1/me/profile', { voiceIntroId: first.id });
    expect(set.status).toBe(200);
    expect(set.body.profile.voiceIntro).toMatchObject({ id: first.id, transcript: { status: 'unavailable' } });
    expect((await as(t.app, bola).get(`/v1/users/${ada.username}`)).body.profile.voiceIntro.id).toBe(first.id);
    expect((await as(t.app, bola).get(`/v1/voice/${first.id}`)).status).toBe(200);
    // A Yap's recording isn't an intro.
    expect((await as(t.app, ada).patch('/v1/me/profile', { voiceIntroId: (await clip(ada)).id })).status).toBe(400);

    const second = await clip(ada, 4, 'intro');
    expect((await as(t.app, ada).patch('/v1/me/profile', { voiceIntroId: second.id })).body.profile.voiceIntro.id).toBe(second.id);
    expect((await db().query(`SELECT 1 FROM media WHERE id = $1`, [first.id])).rowCount).toBe(0);

    await as(t.app, bola).post(`/v1/users/${ada.id}/block`);
    expect((await as(t.app, bola).get(`/v1/users/${ada.username}`)).body.profile.voiceIntro).toBeNull();
    expect((await as(t.app, bola).get(`/v1/voice/${second.id}`)).status).toBe(404);

    expect((await as(t.app, ada).patch('/v1/me/profile', { voiceIntroId: null })).body.profile.voiceIntro).toBeNull();
    expect((await db().query(`SELECT 1 FROM media WHERE id = $1`, [second.id])).rowCount).toBe(0);
  });
});

describe('listening', () => {
  it('counts listens started, time listened and listens to the end', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const post = (await yap(ada, await clip(ada, 4))).body.post;
    const events = (kind: string, valueMs?: number) => ({ postId: post.id, surface: 'yaps', kind, ...(valueMs === undefined ? {} : { valueMs }) });
    const r = await as(t.app, bola).post('/v1/feed/events', {
      events: [events('impression'), events('listen_start'), events('listen', 3800), events('listen_complete'), events('listen_start')],
    });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(4);
    // Time listened counts up to three plays of the recording.
    await as(t.app, bola).post('/v1/feed/events', { events: [events('listen', 600_000)] });
    const stats = (await db().query(`SELECT listens, listen_ms, listen_completes FROM post_stats WHERE post_id = $1`, [post.id])).rows[0];
    expect(stats.listens).toBe(1);
    expect(stats.listen_completes).toBe(1);
    expect(Number(stats.listen_ms)).toBeGreaterThan(3800);
    expect(Number(stats.listen_ms)).toBeLessThanOrEqual(3800 + post.voice.durationMs * 3);
  });
});

describe('your data', () => {
  it('exports your Yaps with their recordings and transcripts; deleting a Yap deletes its recording', async () => {
    t.ctx.transcription = provider(() => vtt('This one is mine to keep'));
    try {
      const ada = await signUp(t.app);
      const post = (await yap(ada, await clip(ada))).body.post;
      await drain();
      const exported = (await as(t.app, ada).get('/v1/me/export')).body;
      const mine = exported.content.voice.find((v: { media_id: string }) => v.media_id === post.voice.id);
      expect(mine).toMatchObject({ purpose: 'yap', post_id: post.id, transcript: 'This one is mine to keep', transcript_status: 'ready' });
      expect(mine.url).toBe(post.voice.url);

      // Reported: kept for the moderators until the report is closed.
      const bola = await signUp(t.app);
      const reported = (await yap(ada, await clip(ada))).body.post;
      expect((await as(t.app, bola).post('/v1/reports', { targetType: 'post', targetId: reported.id, reason: 'spam' })).status).toBe(201);
      await as(t.app, ada).del(`/v1/posts/${reported.id}`);
      expect((await db().query(`SELECT 1 FROM media WHERE id = $1`, [reported.voice.id])).rowCount).toBe(1);

      expect((await as(t.app, ada).del(`/v1/posts/${post.id}`)).status).toBe(200);
      expect((await db().query(`SELECT 1 FROM media WHERE id = $1`, [post.voice.id])).rowCount).toBe(0);
      expect((await db().query(`SELECT 1 FROM voice_clips WHERE media_id = $1`, [post.voice.id])).rowCount).toBe(0);
    } finally {
      t.ctx.transcription = null;
    }
  });

  it('deleting the account clears what the recordings said', async () => {
    t.ctx.transcription = provider(() => vtt('Nobody keeps this after I go'));
    try {
      const ada = await signUp(t.app);
      const post = (await yap(ada, await clip(ada))).body.post;
      await drain();
      expect((await as(t.app, ada).del('/v1/me', { password: ada.password, confirm: 'DELETE' })).status).toBeLessThan(300);
      const left = (await db().query(`SELECT transcript, segments FROM voice_clips WHERE media_id = $1`, [post.voice.id])).rows[0];
      if (left) expect(left).toEqual({ transcript: null, segments: null });
    } finally {
      t.ctx.transcription = null;
    }
  });

  it('admins see how many Yaps there are and where their transcripts stand', async () => {
    const admin = await signUp(t.app);
    await db().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
    const r = await as(t.app, admin).get('/v1/admin/yaps');
    expect(r.status).toBe(200);
    expect(r.body.yaps).toBeGreaterThan(0);
    expect(r.body.transcripts).toMatchObject({
      ready: expect.any(Number),
      unavailable: expect.any(Number),
      pending: expect.any(Number),
      failed: expect.any(Number),
    });
    expect((await as(t.app, await signUp(t.app)).get('/v1/admin/yaps')).status).toBe(403);
  });
});
