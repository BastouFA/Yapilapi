// Stand-in speech and translation services for e2e/voice-messages.spec.ts, so nothing paid is called.
// It answers the OpenAI-compatible speech-to-text and text-to-speech requests and the Anthropic
// Messages request the translator makes. Run it, then start the API pointed at it:
//
//   node apps/web/e2e/speech-stub.mjs 4325
//   TRANSCRIBE_PROVIDER=openai-compatible TRANSCRIBE_API_URL=http://127.0.0.1:4325 \
//   TTS_PROVIDER=openai-compatible TTS_API_URL=http://127.0.0.1:4325 \
//   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:4325 <start the API>
//
// Every clip "says" the same English sentence, and every translation is the same French one.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4325);
export const SAID = 'See you at six, I am bringing the cake and the drinks.';
export const TRANSLATED = 'On se voit à six heures, j’apporte le gâteau et les boissons.';

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) return send(res, 200, 'application/json', JSON.stringify({ data: [] }));
    if (req.method === 'POST' && url.endsWith('/audio/transcriptions')) return send(res, 200, 'text/vtt', `WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n${SAID}\n`);
    // A few bytes labelled MP3: enough for the app to fetch and try to play.
    if (req.method === 'POST' && url.endsWith('/audio/speech')) return send(res, 200, 'audio/mpeg', Buffer.from('ID3stand-in speech'));
    if (req.method === 'POST' && url.includes('/v1/messages'))
      return send(
        res,
        200,
        'application/json',
        JSON.stringify({
          id: 'msg_stub',
          type: 'message',
          role: 'assistant',
          model: 'stub',
          content: [{ type: 'text', text: TRANSLATED }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    send(res, 404, 'text/plain', 'not here');
  });
}).listen(port, '127.0.0.1');

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}
