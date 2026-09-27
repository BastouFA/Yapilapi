# Music: sources, licences and how to switch them on

People can add music to reels, posts (photo, carousel and text) and stories. All of it comes from
one picker, which searches every music source that is switched on. This page explains where the
music comes from, what the licences allow, and what the owner has to do to switch each source on.

## The legal reality

Commercial songs (what is on the radio and the charts) can't be put in people's posts without a
licence from the people who own them: the record label (the recording) and the publisher (the
song itself), usually through collecting societies as well. Large social apps have licensing deals
with labels, publishers and societies, or use a company that licenses whole catalogues to apps.
There is no free way around this.

So YAPILAPI does not pretend. Every song carries the licence it came with, and a song is only
offered, attached or played where that licence allows it:

- **Personal or business use.** Business accounts (profile mode `business`) only see songs cleared
  for commercial use, and can't post with any other.
- **Countries.** A licence can list the countries where a song may be used. The picker leaves out
  songs your country can't use, publishing checks the author's country, and a viewer in a country
  the song isn't licensed for sees the post with a quiet "Music not available in your country".
  When a song is limited to some countries and the person's country isn't known, it isn't allowed.
- **How long a part.** A post or reel plays 5 to 30 seconds, a story up to 15, and never more than
  the licence's `maxClipSeconds`.
- **Expiry and withdrawal.** When a licence ends or a provider takes a song down, posts that use it
  stay up and keep their chip, but play silently with a note ("This song is no longer available").
  New posts can't use it.
- **Credit.** Every catalogue song shows the credit its licence asks for, wherever it plays:
  "Music: Title by Artist · CC BY 4.0" (and a partner's own line, such as a label credit).

Nothing plays or can be attached without a provider that grants those rights.

## Sources

| Source | What it is | On when | Commercial use |
| --- | --- | --- | --- |
| Original sounds (`library`) | The audio of reels people made here. A reel's creator decides whether others may use it (duets and remixes on). | Always | Yes |
| Jamendo (`jamendo`) | Independent music under Creative Commons licences, hundreds of thousands of songs. | `JAMENDO_CLIENT_ID` is set | Only songs whose licence allows it (CC BY, CC0) |
| Licensed catalogue (`licensed`) | A licensing partner's catalogue, including mainstream and major-label music, under the deal the business signs. | `MUSIC_LICENSED_API_URL` and `MUSIC_LICENSED_API_KEY` are set | As the deal says, per song |
| Dev tones (`dev`) | A few generated tones titled "[Dev data]", for development and tests. | Outside production, unless `MUSIC_DEV_PROVIDER=false`. Never in production. | Covers every case |

Sources without credentials are simply off: they are never called, and the picker says which
sources are connected ("Music from Original sounds, Jamendo · Not connected yet: Licensed
catalogue").

### What is stored, and what isn't

- Song **metadata** (title, artist, album, cover, the provider's preview or stream address, the
  licence) is kept in `music_tracks`, so search results are fast and licences can be checked again.
  Search and trending answers from a provider are reused for 10 minutes.
- **Audio is never copied or proxied.** Players load the provider's own address and play only the
  chosen part. Posts and stories keep a reference to the song and the part (start and length),
  never a copy, even where a licence would allow caching.
- Songs in use (on posts, reels, stories, or saved) are read again from their provider once a day
  by the job worker. A song the provider no longer has is marked withdrawn. When a provider is
  switched off, its songs are paused (silent with a note) and come back when it's on again.
- At publish time (including a scheduled post going out) the song is read again from its provider
  and its licence checked for the author's account type, country and part length.

## Jamendo: getting a client id

1. Create a developer account at https://devportal.jamendo.com and create an application. It
   gives a **client id** (and a client secret, which this integration doesn't need).
2. Read Jamendo's API terms. The API is free for non-commercial use; a commercial service may
   need an agreement with Jamendo (Jamendo Licensing). Check this before going live.
3. Set `JAMENDO_CLIENT_ID` on the API service and restart it. The picker then lists Jamendo.

How Jamendo licences are handled (`apps/api/src/lib/music/jamendo.ts`):

- **ND** ("no derivatives") songs are never offered: putting a song under a video or a photo is an
  adaptation under Creative Commons, which ND doesn't allow.
- **SA** ("share alike") songs are never offered: the post would have to be shared under the same
  licence, which people here don't agree to when they post.
- **NC** ("non commercial") songs are for personal accounts only.
- **BY** and **CC0** songs are open to everyone, business accounts included.
- The credit shown is "Title by Artist · CC BY 4.0" (the licence and its version), linking to the
  licence text.

## A licensed catalogue: what a deal involves

To offer mainstream music (what people expect from the big apps), the business needs a licence.
Two ways:

1. **A catalogue licensing company** that has already cleared music for use in social apps and
   gives an API. Examples of companies that offer music licensing or catalogues to apps include
   7digital (Songtradr), Tuned Global, MediaNet, Feed.fm, and, for business accounts, production
   music libraries such as Epidemic Sound. These are examples to evaluate, not partners: no deal
   exists, and offerings change, so check what each one covers today.
2. **Direct deals** with record labels (for example Universal Music Group, Sony Music, Warner Music
   Group, and independent labels through Merlin) and music publishers, plus the collecting
   societies in each country where the app runs (for example PRS in the United Kingdom, SACEM in
   France, ASCAP and BMI in the United States, COSON in Nigeria, MCSK in Kenya, SAMRO in South
   Africa). This is what the largest apps do, and it takes lawyers, time and money.

What to settle in any deal, because the API enforces it:

- which **countries** (territories) each song may be used and played in;
- whether **business accounts** may use it (commercial use), usually a separate catalogue;
- the **longest part** a post, reel or story may play;
- the **credit** to show, and the **reporting** the partner needs (how often each song was used and
  played, by country);
- what happens when a song is **withdrawn** or the licence **ends**;
- whether the audio may be **cached** (this integration never needs it).

Once signed, connect it:

1. Set `MUSIC_LICENSED_API_URL` (the partner's API address), `MUSIC_LICENSED_API_KEY` and
   `MUSIC_LICENSED_NAME` (the name the picker shows) on the API service.
2. The adapter (`apps/api/src/lib/music/licensed.ts`) expects the small JSON API documented at the
   top of that file (search, trending, one song with its licence: `commercialUse`, `territories`,
   `maxClipSeconds`, `attribution`, `expiresAt`). A partner whose API looks different is mapped in
   that one file.
3. Usage reporting for the partner is not built yet: counts per song are in the database
   (`posts.music_track_id`, `moments.music_track_id`), and a report will be needed for the deal.

## Environment variables

| Variable | What | Default |
| --- | --- | --- |
| `JAMENDO_CLIENT_ID` | Jamendo client id. Empty: Jamendo is off. | empty |
| `JAMENDO_API_URL` | Jamendo API address. | `https://api.jamendo.com/v3.0` |
| `MUSIC_LICENSED_API_URL` | The licensing partner's API address. Both this and the key, or neither. | empty |
| `MUSIC_LICENSED_API_KEY` | The licensing partner's API key (a secret). | empty |
| `MUSIC_LICENSED_NAME` | The partner's name in the picker. | `Licensed catalogue` |
| `MUSIC_DEV_PROVIDER` | `false` turns the dev tones off outside production. They are never on in production. | on outside production |

On Render, `JAMENDO_CLIENT_ID`, `MUSIC_LICENSED_API_URL` and `MUSIC_LICENSED_API_KEY` are listed in
`render.yaml` as secrets (`sync: false`): set them in the dashboard.

## API

- `GET /v1/music/sources`: the sources and which are on.
- `GET /v1/music?q=&tab=for_you|trending|saved|original&source=`: the picker.
- `GET /v1/music/tracks/:id`, `GET /v1/music/tracks/:id/posts`: a song's page and the posts you
  can see that play it.
- `PUT|DELETE /v1/music/tracks/:id/save`, `PUT|DELETE /v1/sounds/:id/save`: save for later.
- Posts take `music: { trackId | soundId, startMs, durationMs }`; stories take the same in their
  `music` (with the sticker's style and place); a reel takes `music: { trackId, ... }` for a
  catalogue song, or `soundId` for a sound, as before.
