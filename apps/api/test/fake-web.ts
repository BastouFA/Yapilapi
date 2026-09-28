import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { SafeFetchDeps } from '../src/lib/safe-fetch.ts';

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/**
 * A pretend internet for tests of outside fetches (lib/safe-fetch.ts). `dns` answers every lookup
 * (a function, so a test can change its answer from one lookup to the next). safeFetch's own
 * checking lookup runs as it would in production; only once it has passed are the bytes sent to a
 * local server, which answers by Host and path ("good.example/favicon.ico"). Nothing reaches the
 * internet.
 */
export async function fakeWeb(routes: Record<string, (req: IncomingMessage, body: string) => FakeReply>, dns: (host: string) => string[]) {
  /** Every lookup asked of the fake DNS. */
  const lookups: string[] = [];
  /** Connections that passed the check: the name, the addresses it was allowed to reach and the TLS name. */
  const connections: { host: string; addresses: string[]; servername?: string }[] = [];
  /** Requests the server answered, as "METHOD host/path". */
  const hits: string[] = [];
  const requests: { method: string; host: string; path: string; headers: IncomingMessage['headers']; body: string }[] = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const host = String(req.headers.host);
      hits.push(`${req.method} ${host}${req.url}`);
      requests.push({ method: req.method!, host, path: req.url!, headers: req.headers, body });
      const route = routes[`${host}${req.url}`];
      const reply = route ? route(req, body) : { status: 404, body: 'nope' };
      res.writeHead(reply.status ?? 200, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const deps: SafeFetchDeps = {
    resolve: async (host) => {
      lookups.push(host);
      return dns(host);
    },
    connect: (opts) => {
      const host = String(opts.hostname ?? opts.host);
      const servername = (opts as { servername?: string }).servername;
      const check = opts.lookup;
      if (!check) {
        // No lookup: a host written as an address (or local development). A real local server is reached directly.
        if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return connect({ host, port: Number(opts.port) });
        connections.push({ host, addresses: [host], servername });
        return connect({ host: '127.0.0.1', port });
      }
      return connect({
        host,
        port,
        lookup: (name, o, cb) =>
          check(name, o, (err, address) => {
            if (err) return cb(err, '');
            connections.push({ host: name, addresses: Array.isArray(address) ? address.map((a) => a.address) : [address], servername });
            // Checked: now send the bytes to the local server in place of that address.
            return o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
          }),
      });
    },
  };

  return {
    deps,
    lookups,
    connections,
    hits,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
