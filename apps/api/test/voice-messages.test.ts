import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import type { AiProvider } from '../src/lib/ai/providers.ts';
import type { PushMessage } from '../src/lib/push.ts';
import { setPushSender } from '../src/lib/services.ts';
import { sweepSpeech, type SpeechProvider } from '../src/lib/speech.ts';
import type { TranscriptionProvider } from '../src/lib/transcription.ts';
import { as, jobRunner, signUp, testApp, type JobRunner, type TestUser } from './helpers.ts';

/**
 * Voice messages everyone understands (docs/product/speech-engine.md): voice notes and Yaps are
 * transcribed in a job, members read the words (translated when they don't understand the
 * language) and can hear the translation read out. Stand-in speech-to-text, translation and
 * text-to-speech providers answer; nothing leaves the machine.
 */

/** Speech-to-text that "hears" the words written into the clip ("voice:<words>"). */
function stubTranscriber() {
  const heard: string[] = [];
  const provider: TranscriptionProvider = {
    name: 'stub-stt',
    async transcribe({ audio, filename }) {
      heard.push(filename);
      const words = audio.toString('utf8').replace(/^voice:/, '');
      if (words === 'FAIL') throw new Error('the service is down');
      return words ? `WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n${words}\n` : 'WEBVTT\n';
    },
  };
  return { provider, heard };
}

/** Text-to-speech that counts what it says. */
function stubSpeech() {
  const said: { text: string; voice: string }[] = [];
  const provider: SpeechProvider = {
    name: 'stub-tts',
    model: 'stub-voice-1',
    voiceFor: (lang) => (lang === 'fr' ? 'nova' : 'alloy'),
    async synthesize({ text, voice }) {
      said.push({ text, voice });
      return { audio: Buffer.from(`ID3 spoken:${text}`), mime: 'audio/mpeg', ext: 'mp3' };
    },
  };
  return { provider, said };
}

/** A translation model that answers "EN: <text>" and counts its calls. */
function stubModel() {
  const calls: string[] = [];
  const provider: AiProvider = {
    name: 'stub',
    model: 'stub-1',
    async complete({ prompt }) {
      calls.push(prompt);
      return { text: `EN: ${prompt}`, provider: 'stub', model: 'stub-1' };
    },
  };
  return { provider, calls };
}

let t: BuiltApp;
let runJobs: JobRunner;
const stt = stubTranscriber();
const tts = stubSpeech();
const model = stubModel();
const pushes: { userId: string; msg: PushMessage }[] = [];
const record = async (userId: string, msg: PushMessage) => void pushes.push({ userId, msg });

const db = () => t.ctx.db;
const FRENCH = 'Bonjour à tous, on se retrouve demain matin à la plage avec les enfants';

let ada: TestUser; // speaks French
let bola: TestUser; // reads English
let carl: TestUser; // reads English
let dan: TestUser; // in the group, blocks Ada
let eve: TestUser; // outsider
let crew: string;

async function person(name: string): Promise<TestUser> {
  const u = await signUp(t.app, { birthDate: '1990-04-02' });
  await db().query(`UPDATE profiles SET display_name = $2 WHERE user_id = $1`, [u.id, name]);
  return u;
}

/** A recorded voice clip saying `words`. */
async function clip(owner: TestUser, words: string, opts: { private?: boolean } = {}): Promise<string> {
  const stored = await t.ctx.storage.put(Buffer.from(`voice:${words}`), 'm4a', 'audio/mp4');
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, duration_ms, private) VALUES ($1,'audio',$2,'audio/mp4','ready',$3,4000,$4) RETURNING id`,
    [owner.id, opts.private ? '' : stored.url, stored.key, !!opts.private],
  );
  return rows[0].id;
}

async function sendVoice(from: TestUser, conversationId: string, words: string, extra: Record<string, unknown> = {}) {
  const mediaId = await clip(from, words, { private: !!extra.viewOnce });
  const r = await as(t.app, from).post(`/v1/conversations/${conversationId}/messages`, {
    body: '',
    attachments: [{ mediaId }],
    clientId: `v-${Math.random()}`,
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.message as { id: string; transcript?: unknown };
}

async function drain() {
  for (let i = 0; i < 20; i++) if (!(await runJobs(t.ctx.jobs))) return;
}

/** A connected device: records every realtime event the person gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove };
}

const messagesOf = async (u: TestUser, conversationId = crew) => (await as(t.app, u).get(`/v1/conversations/${conversationId}/messages`)).body.items as any[];
const transcriptOf = async (u: TestUser, id: string, conversationId = crew) => (await messagesOf(u, conversationId)).find((m) => m.id === id)?.transcript;
const batch = (u: TestUser, id: string, target = 'en') => as(t.app, u).post('/v1/translations', { target, items: [{ kind: 'transcript', id }] });
const listen = (u: TestUser, id: string, target = 'en') => as(t.app, u).post(`/v1/messages/${id}/transcript/speech`, { target });
const setFlag = (key: string, enabled: boolean | null) =>
  enabled === null
    ? db().query(`DELETE FROM feature_flags WHERE key = $1`, [key])
    : db().query(`INSERT INTO feature_flags (key, enabled) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`, [key, enabled]);
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeAll(async () => {
  t = await testApp({}, { translator: model.provider });
  t.ctx.transcription = stt.provider;
  t.ctx.speech = tts.provider;
  runJobs = await jobRunner(db());
  setPushSender(record);
  ada = await person('Ada');
  bola = await person('Bola');
  carl = await person('Carl');
  dan = await person('Dan');
  eve = await person('Eve');
  for (const [a, b] of [
    [ada, bola],
    [ada, carl],
    [ada, dan],
  ] as const) {
    const [x, y] = [a.id, b.id].sort();
    await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
  }
  const r = await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id, carl.id, dan.id], title: 'Crew' });
  expect(r.status).toBe(201);
  crew = r.body.conversation.id;
});
beforeEach(() => setPushSender(record));
afterAll(async () => {
  setPushSender(null);
  await t.close();
});

describe('voice messages everyone understands', () => {
  it('says in /v1/flags what voice messages offer, only with providers set up', async () => {
    expect((await as(t.app, null).get('/v1/flags')).body).toMatchObject({
      voiceTranscripts: true,
      voiceTranslation: true,
      voiceListen: true,
      flags: { VOICE_TRANSCRIPTS: true, VOICE_TRANSLATION: true },
    });
    await setFlag('VOICE_TRANSLATION', false);
    expect((await as(t.app, null).get('/v1/flags')).body).toMatchObject({ voiceTranscripts: true, voiceTranslation: false, voiceListen: false });
    await setFlag('VOICE_TRANSLATION', null);
    const bare = await testApp();
    try {
      expect((await as(bare.app, null).get('/v1/flags')).body).toMatchObject({ voiceTranscripts: false, voiceTranslation: false, voiceListen: false });
    } finally {
      await bare.close();
    }
  });

  it('transcribes a voice note in a job, for the chat’s members only', async () => {
    const live = connect(carl);
    const outsider = connect(eve);
    const blocker = connect(dan);
    await as(t.app, dan).post(`/v1/users/${ada.id}/block`);
    try {
      const m = await sendVoice(ada, crew, FRENCH);
      expect(m.transcript).toBeUndefined();
      expect(await transcriptOf(bola, m.id)).toBeUndefined();
      await drain();
      expect(await transcriptOf(bola, m.id)).toEqual({ text: FRENCH, lang: 'fr' });
      expect(await transcriptOf(ada, m.id)).toEqual({ text: FRENCH, lang: 'fr' });
      // The clip went with a name the services recognise.
      expect(stt.heard.at(-1)).toBe('voice.m4a');
      // Live, to the members who see the message.
      expect(live.events.find((e) => e.type === 'message.transcript')?.data).toEqual({
        id: m.id,
        conversationId: crew,
        transcript: { text: FRENCH, lang: 'fr' },
      });
      expect(outsider.events.some((e) => e.type === 'message.transcript')).toBe(false);
      expect(blocker.events.some((e) => e.type === 'message.transcript')).toBe(false);
      // Not to someone outside the chat, nor to someone who blocked the sender, nor through translation.
      expect((await as(t.app, eve).get(`/v1/conversations/${crew}/messages`)).status).toBe(404);
      expect((await messagesOf(dan)).some((x) => x.id === m.id)).toBe(false);
      expect((await batch(eve, m.id)).body.items).toEqual([]);
      expect((await batch(dan, m.id)).body.items).toEqual([]);
      expect((await as(t.app, eve).post('/v1/translate', { kind: 'transcript', id: m.id, target: 'en' })).status).toBe(404);
      expect((await listen(eve, m.id)).status).toBe(404);
      expect((await listen(dan, m.id)).status).toBe(404);
      // In the AI audit log, without the words.
      const log = await db().query(`SELECT provider, context_scopes, status FROM ai_tool_calls WHERE user_id = $1 AND task = 'transcribe'`, [ada.id]);
      expect(log.rows).toContainEqual({ provider: 'stub-stt', context_scopes: [`message:${m.id}`], status: 'ok' });
    } finally {
      await as(t.app, dan).del(`/v1/users/${ada.id}/block`);
      live.remove();
      outsider.remove();
      blocker.remove();
    }
  });

  it('transcribes Yaps too, and leaves silence and failures without words', async () => {
    const r = await as(t.app, ada).post(`/v1/conversations/${crew}/messages`, {
      kind: 'yap',
      attachments: [{ mediaId: await clip(ada, 'Je suis en route, je serai là dans dix minutes environ') }],
      clientId: `y-${Math.random()}`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const quiet = await sendVoice(ada, crew, '');
    const broken = await sendVoice(ada, crew, 'FAIL');
    await drain();
    expect((await transcriptOf(bola, r.body.message.id))?.lang).toBe('fr');
    expect(await transcriptOf(bola, quiet.id)).toBeUndefined();
    expect(await transcriptOf(bola, broken.id)).toBeUndefined();
    const states = await db().query(`SELECT message_id, status FROM message_transcripts WHERE message_id = ANY($1::uuid[])`, [[quiet.id, broken.id]]);
    expect(Object.fromEntries(states.rows.map((x) => [x.message_id, x.status]))).toEqual({ [quiet.id]: 'empty', [broken.id]: 'failed' });
  });

  it('never transcribes view-once or disappearing voice messages', async () => {
    const once = await sendVoice(ada, crew, FRENCH, { viewOnce: true });
    const d = await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id] });
    const direct = d.body.conversation.id as string;
    expect((await as(t.app, ada).put(`/v1/conversations/${direct}/disappearing`, { seconds: 86_400 })).status).toBe(200);
    const fleeting = await sendVoice(ada, direct, FRENCH);
    await drain();
    const rows = await db().query(`SELECT 1 FROM message_transcripts WHERE message_id = ANY($1::uuid[])`, [[once.id, fleeting.id]]);
    expect(rows.rowCount).toBe(0);
    expect(await transcriptOf(bola, fleeting.id, direct)).toBeUndefined();
    expect((await batch(bola, fleeting.id)).body.items).toEqual([]);
    await as(t.app, ada).put(`/v1/conversations/${direct}/disappearing`, { seconds: null });
  });

  it('translates the transcript for a reader who doesn’t understand it, made once for everyone', async () => {
    const m = await sendVoice(ada, crew, `${FRENCH}, et on mange ensemble après`);
    await drain();
    const before = model.calls.length;
    const first = await batch(bola, m.id);
    expect(first.body.items).toEqual([expect.objectContaining({ kind: 'transcript', id: m.id, sourceLanguage: 'fr', targetLanguage: 'en', machine: true })]);
    expect(first.body.items[0].text).toMatch(/^EN: Bonjour/);
    expect(model.calls.length).toBe(before + 1);
    // Carl reads the same translation; nothing new is made.
    const second = await batch(carl, m.id);
    expect(second.body.items[0]).toMatchObject({ text: first.body.items[0].text, cached: true });
    expect((await as(t.app, carl).post('/v1/translate', { kind: 'transcript', id: m.id, target: 'en' })).body.translation.cached).toBe(true);
    expect(model.calls.length).toBe(before + 1);
    // Someone who understands French gets the words as they are.
    await as(t.app, carl).put('/v1/me/translation', { languages: ['fr'], auto: true });
    expect((await batch(carl, m.id)).body.items).toEqual([]);
    await as(t.app, carl).put('/v1/me/translation', { languages: [], auto: true });
    // With VOICE_TRANSLATION off, transcripts aren't translated.
    await setFlag('VOICE_TRANSLATION', false);
    expect((await batch(bola, m.id)).body.items).toEqual([]);
    await setFlag('VOICE_TRANSLATION', null);
  });

  it('reads the translation out on demand: one clip shared by every listener, within the limits', async () => {
    const m = await sendVoice(ada, crew, `${FRENCH}, et Bola apporte le ballon`);
    await drain();
    expect((await listen(bola, m.id, 'fr')).status).toBe(400); // already in French
    const said = tts.said.length;
    const a = await listen(bola, m.id);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ language: 'en' });
    expect(tts.said.length).toBe(said + 1);
    expect(tts.said.at(-1)!.text).toMatch(/^EN: Bonjour/);
    const b = await listen(carl, m.id);
    expect(b.body.url).toBe(a.body.url);
    expect(tts.said.length).toBe(said + 1);
    // The file is there, and it's audio.
    const clip = await db().query(`SELECT storage_key, mime FROM speech_clips WHERE url = $1`, [a.body.url]);
    expect(clip.rows[0].mime).toBe('audio/mpeg');
    expect((await t.ctx.storage.read(clip.rows[0].storage_key)).toString()).toMatch(/^ID3/);

    // The hourly cap for new clips (cached ones are free).
    const other = await sendVoice(ada, crew, `${FRENCH}, puis on rentre à la maison`);
    await drain();
    const cap = t.ctx.config.TTS_PER_HOUR;
    t.ctx.config.TTS_PER_HOUR = 1;
    try {
      const capped = await listen(bola, other.id);
      expect(capped.status).toBe(429);
      expect(capped.body.error.code).toBe('speech_limit');
      expect((await listen(bola, m.id)).status).toBe(200);
    } finally {
      t.ctx.config.TTS_PER_HOUR = cap;
    }
    // The day's budget for everyone.
    const budget = t.ctx.config.TTS_DAILY_CHAR_LIMIT;
    t.ctx.config.TTS_DAILY_CHAR_LIMIT = 10;
    try {
      const spent = await listen(carl, other.id);
      expect(spent.status).toBe(503);
      expect(spent.body.error.code).toBe('speech_unavailable');
    } finally {
      t.ctx.config.TTS_DAILY_CHAR_LIMIT = budget;
    }
    expect((await listen(carl, other.id)).status).toBe(200);
    // No text-to-speech set up: not available.
    t.ctx.speech = null;
    try {
      expect((await listen(carl, other.id)).body.error.code).toBe('speech_unavailable');
    } finally {
      t.ctx.speech = tts.provider;
    }
  });

  it('deletes transcripts, their translations and spoken clips with the message', async () => {
    const m = await sendVoice(ada, crew, `${FRENCH}, sans oublier les serviettes`);
    await drain();
    await batch(bola, m.id);
    const heard = await listen(bola, m.id);
    expect(heard.status).toBe(200);
    const key = (await db().query(`SELECT storage_key FROM speech_clips WHERE url = $1`, [heard.body.url])).rows[0].storage_key as string;
    expect((await as(t.app, ada).post(`/v1/messages/${m.id}/unsend`)).status).toBe(200);
    const left = async (id: string) => ({
      transcripts: (await db().query(`SELECT 1 FROM message_transcripts WHERE message_id = $1`, [id])).rowCount,
      translations: (await db().query(`SELECT 1 FROM translations WHERE kind = 'transcript' AND item_id = $1`, [id])).rowCount,
      uses: (await db().query(`SELECT 1 FROM speech_clip_uses WHERE kind = 'transcript' AND item_id = $1`, [id])).rowCount,
    });
    expect(await left(m.id)).toEqual({ transcripts: 0, translations: 0, uses: 0 });
    expect(await sweepSpeech({ db: db(), storage: t.ctx.storage })).toBeGreaterThanOrEqual(1);
    expect((await db().query(`SELECT 1 FROM speech_clips WHERE storage_key = $1`, [key])).rowCount).toBe(0);
    await expect(t.ctx.storage.read(key)).rejects.toThrow();

    // A message deleted outright (as when it disappears) takes everything too.
    const gone = await sendVoice(ada, crew, `${FRENCH}, et le parasol bleu`);
    await drain();
    await batch(bola, gone.id);
    await db().query(`DELETE FROM messages WHERE id = $1`, [gone.id]);
    expect(await left(gone.id)).toEqual({ transcripts: 0, translations: 0, uses: 0 });
  });

  it('puts your own transcripts in your data export, and nobody else’s', async () => {
    const m = await sendVoice(ada, crew, `${FRENCH}, avec le gâteau au chocolat`);
    await drain();
    const mine = (await as(t.app, ada).get('/v1/me/export')).body;
    expect(mine.chats.voiceTranscripts).toContainEqual(
      expect.objectContaining({ message_id: m.id, body: `${FRENCH}, avec le gâteau au chocolat`, lang: 'fr' }),
    );
    expect(mine.settings.preferences?.transcribe_voice ?? true).toBe(true);
    const theirs = (await as(t.app, bola).get('/v1/me/export')).body;
    expect(theirs.chats.voiceTranscripts).toEqual([]);
    expect(JSON.stringify(theirs)).not.toContain('gâteau au chocolat');
  });

  it('makes no transcripts of the voice messages of someone who turned it off, and deletes the old ones', async () => {
    const old = await sendVoice(ada, crew, `${FRENCH}, et les lunettes de soleil`);
    await drain();
    await batch(bola, old.id);
    expect((await as(t.app, ada).get('/v1/me/ai-settings')).body.transcribeVoice).toBe(true);
    expect((await as(t.app, ada).put('/v1/me/ai-settings', { transcribeVoice: false })).body.transcribeVoice).toBe(false);
    expect(await transcriptOf(bola, old.id)).toBeUndefined();
    expect((await db().query(`SELECT 1 FROM translations WHERE kind = 'transcript' AND item_id = $1`, [old.id])).rowCount).toBe(0);
    const heard = stt.heard.length;
    const fresh = await sendVoice(ada, crew, FRENCH);
    await drain();
    expect(stt.heard.length).toBe(heard);
    expect(await transcriptOf(bola, fresh.id)).toBeUndefined();
    // Turned off while one was waiting: none is made.
    await as(t.app, ada).put('/v1/me/ai-settings', { transcribeVoice: true });
    const waiting = await sendVoice(ada, crew, FRENCH);
    await as(t.app, ada).put('/v1/me/ai-settings', { transcribeVoice: false });
    await drain();
    expect(await transcriptOf(bola, waiting.id)).toBeUndefined();
    expect(stt.heard.length).toBe(heard);
    await as(t.app, ada).put('/v1/me/ai-settings', { transcribeVoice: true });
  });

  it('says a voice note’s first words in its push, never a disappearing one’s', async () => {
    const d = await as(t.app, ada).post('/v1/conversations', { memberIds: [carl.id] });
    const direct = d.body.conversation.id as string;
    await as(t.app, carl).post(`/v1/conversations/${direct}/read`);
    pushes.length = 0;
    const long = `${FRENCH}, et après on ira manger une glace sur la grande place du marché`;
    await sendVoice(ada, direct, long);
    await settle();
    // The push waits for the words.
    expect(pushes.filter((p) => p.userId === carl.id && p.msg.data?.type === 'message')).toHaveLength(0);
    await drain();
    await settle();
    const sent = pushes.filter((p) => p.userId === carl.id && p.msg.data?.type === 'message');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.body).toMatch(/^Ada: Voice message: Bonjour à tous, on se retrouve .*…$/);
    expect(sent[0]!.msg.body.length).toBeLessThan(120);

    // Disappearing: never transcribed, and the push only says what it is.
    await as(t.app, carl).post(`/v1/conversations/${direct}/read`);
    await as(t.app, ada).put(`/v1/conversations/${direct}/disappearing`, { seconds: 86_400 });
    pushes.length = 0;
    await sendVoice(ada, direct, FRENCH);
    await settle();
    await drain();
    const quiet = pushes.filter((p) => p.userId === carl.id && p.msg.data?.type === 'message');
    expect(quiet.map((p) => p.msg.body)).toEqual(['Ada: Voice message']);
    await as(t.app, ada).put(`/v1/conversations/${direct}/disappearing`, { seconds: null });
  });

  it('hides everything when speech-to-text isn’t set up', async () => {
    const m = await sendVoice(ada, crew, `${FRENCH}, rendez-vous à neuf heures`);
    await drain();
    expect(await transcriptOf(bola, m.id)).toBeTruthy();
    t.ctx.transcription = null;
    try {
      expect(await transcriptOf(bola, m.id)).toBeUndefined();
      expect((await as(t.app, null).get('/v1/flags')).body).toMatchObject({ voiceTranscripts: false, voiceTranslation: false, voiceListen: false });
      expect((await listen(bola, m.id)).body.error.code).toBe('speech_unavailable');
      const fresh = await sendVoice(ada, crew, FRENCH);
      expect((await db().query(`SELECT 1 FROM message_transcripts WHERE message_id = $1`, [fresh.id])).rowCount).toBe(0);
    } finally {
      t.ctx.transcription = stt.provider;
    }
    // And with the flag off.
    await setFlag('VOICE_TRANSCRIPTS', false);
    expect(await transcriptOf(bola, m.id)).toBeUndefined();
    expect((await batch(bola, m.id)).body.items).toEqual([]);
    await setFlag('VOICE_TRANSCRIPTS', null);
  });
});
