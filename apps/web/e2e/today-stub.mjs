// Stand-in model and voice for e2e/today.spec.ts, so nothing paid is called. It answers the
// Anthropic Messages request that writes Yapilapi Today (one segment per post it is given) and the
// OpenAI-compatible text-to-speech request (a real second of MP3, so the browser plays it through).
// Run it, then start the API pointed at it:
//
//   node apps/web/e2e/today-stub.mjs 4328
//   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:4328 \
//   TTS_PROVIDER=openai-compatible TTS_API_URL=http://127.0.0.1:4328 <start the API>
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const port = Number(process.argv[2] ?? 4328);
// A second of quiet tone, made once with the API's own ffmpeg.
const ffmpeg = process.env.FFMPEG_PATH || createRequire(new URL('../../api/package.json', import.meta.url))('ffmpeg-static');
const MP3 = execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=1',
  '-ac',
  '1',
  '-b:a',
  '32k',
  '-f',
  'mp3',
  'pipe:1',
]);

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.endsWith('/audio/speech')) return send(res, 200, 'audio/mpeg', MP3);
    if (req.method === 'POST' && url.includes('/v1/messages')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const prompt = typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content : '';
      const items = [...prompt.matchAll(/^\[(\d+)\] @(\S+)/gm)];
      const segments = items.map((m) => ({ text: `@${m[2]} shared something new today.`, posts: [Number(m[1])] }));
      return send(
        res,
        200,
        'application/json',
        JSON.stringify({
          id: 'msg_stub',
          type: 'message',
          role: 'assistant',
          model: 'stub',
          content: [{ type: 'text', text: JSON.stringify({ segments }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    }
    send(res, 404, 'text/plain', 'not here');
  });
}).listen(port, '127.0.0.1');

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}
