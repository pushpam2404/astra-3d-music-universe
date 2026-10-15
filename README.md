# Astra

Your Spotify listening, mapped as a galaxy. Genres are suns, artists are planets, and songs are moons. Artists that sound alike end up in the same cluster, whatever language they sing in.

Live: https://astra-3d-music-universe.vercel.app

## What it shows

- **Everything Spotify lets an app see:** your top artists and top songs for the last 4 weeks, 6 months and all time, your recent plays, and your Liked Songs, merged into one universe.
- **Clusters by sound.** Spotify no longer gives apps artist genres, so Astra looks them up on Last.fm, Wikidata and MusicBrainz. It then groups artists by shared genres, home country and collaborations, and names each cluster after what makes it distinctive.
- **Why each thing is there.** Click an artist or song to see the Spotify list it came from, for example "Top artist, all time (#4)" or "In your Liked Songs".

Spotify only exposes recent top lists and Liked Songs to apps. Music you played years ago without liking it won't appear, even when Spotify still counts the artist as one of your top artists.

## Running it

```bash
npm install
cp .env.example .env   # add your Spotify app's client id and secret, optionally a Last.fm API key
npm run dev            # http://127.0.0.1:5173
```

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), add `http://127.0.0.1:5173/api/auth/callback` as a Redirect URI. For the deployed site, add `https://<your-domain>/api/auth/callback`. Spotify rejects `localhost`; use `127.0.0.1`.

While the Spotify app is in Development Mode, only accounts listed under **User Management** can connect, up to 5 users.

## Deploying

The project deploys to Vercel as-is. `vercel.json` routes `/api/*` to the Express backend in `api/index.js`, and the Vite build is served statically. Set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SESSION_SECRET` and, optionally, `LASTFM_API_KEY` as environment variables.

There is no database. Sessions live in an encrypted cookie, and each browser remembers the artist genres it has already looked up.
