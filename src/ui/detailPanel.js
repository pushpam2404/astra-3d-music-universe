// src/ui/detailPanel.js
/**
 * Renders the details of a selected cluster, artist or song into the side panel.
 * Everything shown is real: why it's in your universe comes from the Spotify lists it
 * appeared in (ranks, Liked Songs, recent plays), genres from Last.fm/Wikidata/MusicBrainz.
 */

const RANGE_LABEL = { short_term: 'last 4 weeks', medium_term: 'last 6 months', long_term: 'all time' };
const RANGE_ORDER = ['long_term', 'medium_term', 'short_term'];

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  [].concat(children).filter(Boolean).forEach(c => node.append(c));
  return node;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function section(title, content) {
  return el('section', { class: 'detail-section' }, [el('h3', { text: title }), content]);
}

/** Short tag for a song in a list: its best chart position, else Liked/recent. */
function songMeta(track) {
  const ranks = track.ranks || {};
  const best = RANGE_ORDER.map(r => ranks[r] && { r, rank: ranks[r] }).filter(Boolean).sort((a, b) => a.rank - b.rank)[0];
  if (best) return `#${best.rank} ${RANGE_LABEL[best.r]}`;
  if (track.liked) return 'Liked';
  if (track.recentPlays) return 'Played recently';
  return '';
}

export class DetailPanel {
  /**
   * @param {HTMLElement} container
   * @param {{ resolve: (id) => node, onSelect: (node) => void, onFly: (node) => void, isDemo: () => boolean, likedSongsConnected: () => boolean }} ctx
   */
  constructor(container, ctx) {
    this.container = container;
    this.ctx = ctx;
  }

  neighbors(node, type) {
    return [...(node.neighbors || [])].map(id => this.ctx.resolve(id)).filter(n => n && n.type === type);
  }

  chipFor(node) {
    return el('button', { class: 'chip', type: 'button', onclick: () => this.ctx.onSelect(node) }, [
      el('span', { class: 'chip-dot', style: `background:${node.color}` }),
      node.name
    ]);
  }

  songList(tracks) {
    return el('ul', { class: 'song-list' }, tracks.map(t =>
      el('li', {}, el('button', { type: 'button', onclick: () => this.ctx.onSelect(t) }, [
        el('span', { text: t.name }),
        el('span', { class: 'song-meta', text: songMeta(t) })
      ]))
    ));
  }

  actions(node) {
    const items = [];
    if (node.spotifyUrl) {
      items.push(el('a', { class: 'btn btn-spotify', href: node.spotifyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open in Spotify' }));
    }
    items.push(el('button', { class: 'btn', type: 'button', text: 'Center view', onclick: () => this.ctx.onFly(node) }));
    return el('div', { class: 'detail-actions' }, items);
  }

  render(node) {
    this.container.replaceChildren();
    if (node.type === 'genre') this.renderCluster(node);
    else if (node.type === 'artist') this.renderArtist(node);
    else this.renderSong(node);
    this.container.parentElement.scrollTop = 0;
  }

  renderCluster(node) {
    const artists = this.neighbors(node, 'artist').sort((a, b) => b.plays - a.plays);
    const songCount = artists.reduce((s, a) => s + this.neighbors(a, 'track').length, 0);
    const parts = [
      el('p', { class: 'detail-kind', text: 'Cluster' }),
      el('h2', { class: 'detail-title', text: node.name }),
      el('p', { class: 'detail-by', text: `${plural(artists.length, 'artist')}, ${plural(songCount, 'song')}` })
    ];
    if (node.subgenres?.length) {
      parts.push(section('Sounds like', el('div', { class: 'chips' }, node.subgenres.map(g => el('span', { class: 'chip', text: g })))));
    }
    parts.push(section('Artists', el('ul', { class: 'song-list' }, artists.map(a => {
      const songs = this.neighbors(a, 'track').length;
      return el('li', {}, el('button', { type: 'button', onclick: () => this.ctx.onSelect(a) }, [
        el('span', { text: a.name }),
        el('span', { class: 'song-meta', text: songs ? plural(songs, 'song') : '' })
      ]));
    }))));
    if (!this.ctx.isDemo()) {
      parts.push(el('p', { class: 'source-note', text: 'Artists are grouped by shared genres, home country and collaborations.' }));
    }
    parts.push(this.actions(node));
    this.container.append(...parts);
  }

  renderArtist(node) {
    const clusters = this.neighbors(node, 'genre');
    const tracks = this.neighbors(node, 'track').sort((a, b) => b.plays - a.plays);
    const parts = [
      el('p', { class: 'detail-kind', text: node.isBridge ? 'Artist between two clusters' : 'Artist' }),
      el('h2', { class: 'detail-title', text: node.name })
    ];
    if (clusters.length) parts.push(el('div', { class: 'chips' }, clusters.map(c => this.chipFor(c))));

    if (!this.ctx.isDemo()) {
      const reasons = RANGE_ORDER
        .filter(r => node.ranks?.[r])
        .map(r => `Top artist, ${RANGE_LABEL[r]} (#${node.ranks[r]})`);
      const charted = tracks.filter(t => Object.keys(t.ranks || {}).length).length;
      const liked = tracks.filter(t => t.liked).length;
      const recent = tracks.filter(t => t.recentPlays).length;
      if (charted) reasons.push(`${plural(charted, 'song')} in your top songs`);
      if (liked) reasons.push(`${plural(liked, 'Liked Song')}`);
      if (recent) reasons.push(`${plural(recent, 'song')} played recently`);
      if (!reasons.length) reasons.push('Featured on a song you listen to');
      parts.push(section('Why they’re here', el('ul', { class: 'reason-list' }, reasons.map(r => el('li', { text: r })))));
    }

    if (tracks.length) {
      parts.push(section(`Your songs (${tracks.length})`, this.songList(tracks)));
    } else if (!this.ctx.isDemo()) {
      const note = this.ctx.likedSongsConnected()
        ? 'None of their songs are in your top songs, recent plays or Liked Songs, so there are no moons here. Spotify ranks them as a top artist from your overall listening history.'
        : 'None of their songs are in your top songs or recent plays. Liked Songs aren’t connected yet; reconnect Spotify to include them.';
      parts.push(section('Your songs', el('p', { class: 'empty-note', text: note })));
    }

    if (node.subgenres?.length) {
      parts.push(section('Genres', el('div', {}, [
        el('div', { class: 'chips' }, node.subgenres.map(g => el('span', { class: 'chip', text: g }))),
        this.ctx.isDemo() ? null : el('p', { class: 'source-note', text: 'From Last.fm, Wikidata and MusicBrainz.' })
      ])));
    } else if (!this.ctx.isDemo()) {
      parts.push(section('Genres', el('p', { class: 'empty-note', text: 'No genre data found for this artist yet, so they’re placed by home country and collaborations.' })));
    }

    parts.push(this.actions(node));
    this.container.append(...parts);
  }

  renderSong(node) {
    const artist = this.ctx.resolve(node.artistId);
    const feat = node.featArtistId ? this.ctx.resolve(node.featArtistId) : null;
    const by = el('p', { class: 'detail-by' }, [
      'by ',
      artist ? el('button', { type: 'button', text: artist.name, onclick: () => this.ctx.onSelect(artist) }) : 'unknown artist',
      feat ? ' with ' : null,
      feat ? el('button', { type: 'button', text: feat.name, onclick: () => this.ctx.onSelect(feat) }) : null
    ]);
    const parts = [
      el('p', { class: 'detail-kind', text: ['Song', formatDuration(node.durationMs)].filter(Boolean).join(', ') }),
      el('h2', { class: 'detail-title', text: node.name }),
      by
    ];

    if (!this.ctx.isDemo()) {
      const reasons = RANGE_ORDER
        .filter(r => node.ranks?.[r])
        .map(r => `Top song, ${RANGE_LABEL[r]} (#${node.ranks[r]})`);
      if (node.liked) reasons.push('In your Liked Songs');
      if (node.recentPlays) reasons.push(node.recentPlays > 1 ? `Played ${node.recentPlays} times recently` : 'Played recently');
      if (reasons.length) parts.push(section('Why it’s here', el('ul', { class: 'reason-list' }, reasons.map(r => el('li', { text: r })))));
    }

    parts.push(this.actions(node));
    this.container.append(...parts);
  }
}
