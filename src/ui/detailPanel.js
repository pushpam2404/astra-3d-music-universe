// src/ui/detailPanel.js
/**
 * Renders the details of a selected cluster, artist or song into the side panel.
 * Everything shown is real: why it's in your universe comes from the Spotify lists it
 * appeared in (ranks, Liked Songs, recent plays) plus your multi-year Streaming History
 * (exact plays, hours, discovery era, peak era, dormancy, and year-by-year timeline).
 */
import { nodeMatchesLens } from '../renderer/celestialFactory.js';
import { formatMonthYear, formatRelativeDays } from '../etl/historyParser.js';
import { animateSparkbars } from './motionFx.js';
import { availableLenses } from '../config/lenses.js';

const RANGE_LABEL = { short_term: 'last 4 weeks', medium_term: 'last 6 months', long_term: 'all time' };
const RANGE_ORDER = ['long_term', 'medium_term', 'short_term'];

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  [].concat(children).filter(Boolean).forEach(c => node.append(c));
  return node;
}

const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatListeningTime(minutes) {
  if (!minutes) return '';
  if (minutes < 60) return `${minutes} min`;
  const hrs = (minutes / 60).toFixed(1).replace(/\.0$/, '');
  return `${hrs} hr${hrs === '1' ? '' : 's'}`;
}

function section(title, content) {
  return el('section', { class: 'detail-section' }, [el('h3', { text: title }), content]);
}

/** Short tag for a song or artist in a list: play count + memory badge or chart rank. */
export function itemMetaLabel(item) {
  const h = item.history;
  const parts = [];
  if (h?.plays) parts.push(`${h.plays.toLocaleString()}×`);
  if (h?.shortBadge) {
    parts.push(h.shortBadge);
  } else {
    const ranks = item.ranks || {};
    const best = RANGE_ORDER.map(r => ranks[r] && { r, rank: ranks[r] }).filter(Boolean).sort((a, b) => a.rank - b.rank)[0];
    if (best) parts.push(`#${best.rank} ${RANGE_LABEL[best.r]}`);
    else if (item.liked) parts.push('Liked');
    else if (item.recentPlays) parts.push('Recent');
  }
  return parts.join(' · ');
}

/** Renders the year-by-year bar chart (2020–2026) for a cluster, artist, or song. */
function renderYearTimeline(byYear, accentColor = '#F4E9C8') {
  if (!byYear || !Object.keys(byYear).length) return null;
  const years = ['2020', '2021', '2022', '2023', '2024', '2025', '2026'].filter(y => y in byYear || Number(y) >= 2021);
  const maxPlays = Math.max(1, ...years.map(y => byYear[y] || 0));

  return el('div', { class: 'year-chart' }, years.map(y => {
    const count = byYear[y] || 0;
    const pct = count > 0 ? Math.max(8, Math.round((count / maxPlays) * 100)) : 2;
    const isPeak = count === maxPlays && count > 0;
    return el('div', { class: `year-col${isPeak ? ' is-peak' : ''}`, title: `${y}: ${count.toLocaleString()} plays` }, [
      el('span', { class: 'year-count', text: count > 0 ? count.toLocaleString() : '·' }),
      el('div', { class: 'year-bar-track' }, [
        el('div', {
          class: 'year-bar-fill',
          style: `height:${pct}%;background:${isPeak ? accentColor : 'rgba(236, 234, 246, 0.32)'}`
        })
      ]),
      el('span', { class: 'year-label', text: `'${y.slice(2)}` })
    ]);
  }));
}

/** Renders temporal memory badges & telemetry card for an artist or song. */
function renderHistoryCard(node) {
  const h = node.history;
  if (!h || !h.plays) return null;

  const badges = [];
  if (h.tags?.includes('past_fav')) {
    badges.push(el('span', { class: 'memory-badge badge-past-fav', text: `Past favorite · ${h.peakEra}` }));
  }
  if (h.tags?.includes('dormant')) {
    badges.push(el('span', { class: 'memory-badge badge-dormant', text: `Haven’t heard in ${formatRelativeDays(h.daysSinceLast).replace(' ago', '')}` }));
  }
  if (h.tags?.includes('all_time_staple')) {
    badges.push(el('span', { class: 'memory-badge badge-staple', text: 'All-time staple' }));
  } else if (h.tags?.includes('current_rotation')) {
    badges.push(el('span', { class: 'memory-badge badge-current', text: 'Current rotation' }));
  } else if (h.tags?.includes('early_era') && !h.tags?.includes('past_fav')) {
    badges.push(el('span', { class: 'memory-badge badge-era', text: `Heard back in ${h.peakEra}` }));
  }

  const statsGrid = el('div', { class: 'memory-stats-grid' }, [
    el('div', { class: 'memory-stat' }, [
      el('span', { class: 'memory-stat-label', text: 'Total plays' }),
      el('span', { class: 'memory-stat-val', text: `${h.plays.toLocaleString()} (${formatListeningTime(h.minutes)})` })
    ]),
    el('div', { class: 'memory-stat' }, [
      el('span', { class: 'memory-stat-label', text: 'First heard' }),
      el('span', { class: 'memory-stat-val', text: `${h.firstEra} (${formatMonthYear(h.firstPlayed)})` })
    ]),
    el('div', { class: 'memory-stat' }, [
      el('span', { class: 'memory-stat-label', text: 'Peak era' }),
      el('span', { class: 'memory-stat-val', text: `${h.peakEra} (${(h.byYear?.[h.peakYear] || 0).toLocaleString()} in ${h.peakYear})` })
    ]),
    el('div', { class: 'memory-stat' }, [
      el('span', { class: 'memory-stat-label', text: 'Last heard' }),
      el('span', { class: 'memory-stat-val', text: `${formatMonthYear(h.lastPlayed)} (${formatRelativeDays(h.daysSinceLast)})` })
    ])
  ]);

  const timeline = renderYearTimeline(h.byYear, node.color || '#F4E9C8');

  return section('Listening memory & timeline', el('div', { class: 'memory-card' }, [
    badges.length ? el('div', { class: 'memory-badges' }, badges) : null,
    h.memoryNote ? el('p', { class: 'memory-note', text: h.memoryNote }) : null,
    statsGrid,
    timeline
  ]));
}

export class DetailPanel {
  /**
   * @param {HTMLElement} container
   * @param {{ resolve: (id) => node, onSelect: (node) => void, onFly: (node) => void, isDemo: () => boolean, likedSongsConnected: () => boolean, getActiveLens?: () => string }} ctx
   */
  constructor(container, ctx) {
    this.container = container;
    this.ctx = ctx;
  }

  neighbors(node, type) {
    return [...(node.neighbors || [])].map(id => this.ctx.resolve(id)).filter(n => n && n.type === type && n.meshGroup?.visible !== false);
  }

  chipFor(node) {
    return el('button', { class: 'chip', type: 'button', onclick: () => this.ctx.onSelect(node) }, [
      el('span', { class: 'chip-dot', style: `background:${node.color}` }),
      node.name
    ]);
  }

  songList(tracks, showArtistName = false, currentArtistId = null) {
    return el('ul', { class: 'song-list' }, tracks.map(t => {
      const otherNames = [];
      if (showArtistName) {
        const artist = this.ctx.resolve(t.artistId);
        if (artist) otherNames.push(artist.name);
      } else if (currentArtistId) {
        if (t.artistId && t.artistId !== currentArtistId) {
          const primary = this.ctx.resolve(t.artistId);
          if (primary) otherNames.push(primary.name);
        }
        (t.featArtistIds || []).forEach(fId => {
          if (fId !== currentArtistId) {
            const fa = this.ctx.resolve(fId);
            if (fa && !otherNames.includes(fa.name)) otherNames.push(fa.name);
          }
        });
      }
      const collabSub = otherNames.length
        ? (showArtistName ? otherNames.join(', ') : `with ${otherNames.join(', ')}`)
        : null;

      return el('li', {}, el('button', { type: 'button', onclick: () => this.ctx.onSelect(t) }, [
        el('span', { class: 'song-main' }, [
          el('span', { class: 'song-title', text: t.name }),
          collabSub ? el('span', { class: 'song-sub', text: collabSub }) : null
        ]),
        el('span', { class: 'song-meta', text: itemMetaLabel(t) })
      ]));
    }));
  }

  actions(node) {
    const items = [];
    if (node.spotifyUrl) {
      items.push(el('a', { class: 'btn btn-spotify', href: node.spotifyUrl, target: '_blank', rel: 'noopener noreferrer' }, [
        el('svg', { class: 'btn-icon', width: '14', height: '14', viewBox: '0 0 24 24', fill: 'currentColor' }, [
          el('path', { d: 'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z' })
        ]),
        document.createTextNode('Open in Spotify')
      ]));
    }
    items.push(el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => this.ctx.onFly(node) }, [
      el('svg', { class: 'btn-icon', width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
        el('circle', { cx: '12', cy: '12', r: '10' }),
        el('line', { x1: '22', y1: '12', x2: '18', y2: '12' }),
        el('line', { x1: '6', y1: '12', x2: '2', y2: '12' }),
        el('line', { x1: '12', y1: '6', x2: '12', y2: '2' }),
        el('line', { x1: '12', y1: '22', x2: '12', y2: '18' })
      ]),
      document.createTextNode('Center view')
    ]));
    return el('div', { class: 'detail-actions' }, items);
  }

  render(node) {
    this.container.replaceChildren();
    this.container.style.setProperty('--node-accent', node.color || '#F4E9C8');
    if (node.type === 'genre') this.renderCluster(node);
    else if (node.type === 'artist') this.renderArtist(node);
    else this.renderSong(node);
    this.container.parentElement.scrollTop = 0;
    this.container.querySelectorAll('.year-chart').forEach(animateSparkbars);
  }

  renderCluster(node) {
    const artists = this.neighbors(node, 'artist').sort((a, b) => (b.history?.plays || b.plays) - (a.history?.plays || a.plays));
    const allClusterTracks = [];
    const seenTrackIds = new Set();
    artists.forEach(a => {
      this.neighbors(a, 'track').forEach(t => {
        if (!seenTrackIds.has(t.id)) {
          seenTrackIds.add(t.id);
          allClusterTracks.push(t);
        }
      });
    });
    allClusterTracks.sort((a, b) => (b.history?.plays || b.plays) - (a.history?.plays || a.plays));

    const hist = node.history;
    const summaryParts = [`${plural(artists.length, 'artist')}, ${plural(allClusterTracks.length, 'song')}`];
    if (hist?.plays) {
      summaryParts.push(`${hist.plays.toLocaleString()} plays (${formatListeningTime(hist.minutes)})`);
    }

    const parts = [
      el('p', { class: 'detail-kind', text: 'Cluster' }),
      el('h2', { class: 'detail-title', text: node.name }),
      el('p', { class: 'detail-by', text: summaryParts.join(' · ') })
    ];

    if (node.subgenres?.length) {
      parts.push(section('Sounds like', el('div', { class: 'chips' }, node.subgenres.map(g => el('span', { class: 'chip', text: g })))));
    }

    if (hist?.byYear && Object.keys(hist.byYear).length) {
      const badges = [];
      if (hist.peakYear) badges.push(el('span', { class: 'memory-badge badge-era', text: `Peak year: ${hist.peakYear}` }));
      if (hist.pastFavCount) badges.push(el('span', { class: 'memory-badge badge-past-fav', text: `${hist.pastFavCount} past favorites` }));
      if (hist.dormantCount) badges.push(el('span', { class: 'memory-badge badge-dormant', text: `${hist.dormantCount} dormant` }));
      parts.push(section('Cluster timeline', el('div', { class: 'memory-card' }, [
        badges.length ? el('div', { class: 'memory-badges' }, badges) : null,
        renderYearTimeline(hist.byYear, node.color)
      ])));
    }

    // Accessible inside-cluster explorer: toggle between Artists and Songs, and filter by memory/era!
    let mode = 'artists'; // 'artists' | 'songs'
    let filter = this.ctx.getActiveLens?.() || 'all';
    const listContainer = el('div', { class: 'cluster-explorer-list' });

    const filters = [
      { id: 'all', label: 'All' },
      ...availableLenses([...artists, ...allClusterTracks]).map(l => ({ id: l.id, label: l.short }))
    ];

    const modeArtistsBtn = el('button', { type: 'button', class: 'sub-tab is-active', text: `Artists (${artists.length})` });
    const modeSongsBtn = el('button', { type: 'button', class: 'sub-tab', text: `Songs (${allClusterTracks.length})` });
    const filterRow = el('div', { class: 'inline-filter-row' });

    const renderExplorer = () => {
      modeArtistsBtn.classList.toggle('is-active', mode === 'artists');
      modeSongsBtn.classList.toggle('is-active', mode === 'songs');
      [...filterRow.children].forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.filter === filter);
      });

      if (mode === 'artists') {
        const filtered = artists.filter(a => nodeMatchesLens(a, filter) || (filter !== 'all' && this.neighbors(a, 'track').some(t => nodeMatchesLens(t, filter))));
        if (!filtered.length) {
          listContainer.replaceChildren(el('p', { class: 'empty-note', text: 'No artists in this cluster match that memory filter.' }));
          return;
        }
        listContainer.replaceChildren(el('ul', { class: 'song-list' }, filtered.map(a => {
          const songs = this.neighbors(a, 'track').length;
          const meta = a.history?.plays
            ? `${a.history.plays.toLocaleString()}× · ${a.history.shortBadge || plural(songs, 'song')}`
            : (songs ? plural(songs, 'song') : '');
          return el('li', {}, el('button', { type: 'button', onclick: () => this.ctx.onSelect(a) }, [
            el('span', { class: 'song-main' }, [
              el('span', { class: 'song-title', text: a.name })
            ]),
            el('span', { class: 'song-meta', text: meta })
          ]));
        })));
      } else {
        const filtered = allClusterTracks.filter(t => nodeMatchesLens(t, filter));
        if (!filtered.length) {
          listContainer.replaceChildren(el('p', { class: 'empty-note', text: 'No songs in this cluster match that memory filter.' }));
          return;
        }
        listContainer.replaceChildren(this.songList(filtered.slice(0, 150), true));
      }
    };

    modeArtistsBtn.addEventListener('click', () => { mode = 'artists'; renderExplorer(); });
    modeSongsBtn.addEventListener('click', () => { mode = 'songs'; renderExplorer(); });

    filters.forEach(f => {
      const btn = el('button', {
        type: 'button',
        class: `mini-pill${f.id === filter ? ' is-active' : ''}`,
        'data-filter': f.id,
        text: f.label,
        onclick: () => {
          filter = f.id;
          if (this.ctx.onSetLens && this.ctx.getActiveLens?.() !== f.id) {
            this.ctx.onSetLens(f.id);
          } else {
            renderExplorer();
          }
        }
      });
      filterRow.append(btn);
    });

    renderExplorer();

    parts.push(el('section', { class: 'detail-section' }, [
      el('div', { class: 'sub-tabs-row' }, [modeArtistsBtn, modeSongsBtn]),
      hist ? filterRow : null,
      listContainer
    ]));

    if (!this.ctx.isDemo()) {
      parts.push(el('p', { class: 'source-note', text: 'Artists are grouped by shared genres, home country, collaborations and listening sessions.' }));
    }
    parts.push(this.actions(node));
    this.container.append(...parts);
  }

  renderArtist(node) {
    const clusters = [...(node.neighbors || [])].map(id => this.ctx.resolve(id)).filter(n => n && n.type === 'genre');
    const tracks = this.neighbors(node, 'track').sort((a, b) => (b.history?.plays || b.plays) - (a.history?.plays || a.plays));
    const collaborators = [...(node.collaboratorArtistIds || [])]
      .map(id => this.ctx.resolve(id))
      .filter(a => a && a.meshGroup?.visible !== false)
      .sort((a, b) => (b.history?.plays || b.plays) - (a.history?.plays || a.plays));

    const parts = [
      el('p', { class: 'detail-kind', text: node.isBridge ? 'Artist between two clusters' : 'Artist' }),
      el('h2', { class: 'detail-title', text: node.name })
    ];
    if (clusters.length) parts.push(el('div', { class: 'chips' }, clusters.map(c => this.chipFor(c))));

    const histCard = renderHistoryCard(node);
    if (histCard) parts.push(histCard);

    if (collaborators.length) {
      parts.push(section(`Collaborators in your universe (${collaborators.length})`, el('div', { class: 'chips' }, collaborators.map(c => this.chipFor(c)))));
    }

    if (!this.ctx.isDemo()) {
      const reasons = RANGE_ORDER
        .filter(r => node.ranks?.[r])
        .map(r => `Top artist, ${RANGE_LABEL[r]} (#${node.ranks[r]})`);
      const charted = tracks.filter(t => Object.keys(t.ranks || {}).length).length;
      const liked = tracks.filter(t => t.liked).length;
      const recent = tracks.filter(t => t.recentPlays).length;
      const pastFavSongs = tracks.filter(t => t.history?.tags?.includes('past_fav')).length;
      const dormantSongs = tracks.filter(t => t.history?.tags?.includes('dormant')).length;
      if (charted) reasons.push(`${plural(charted, 'song')} in your top charts`);
      if (liked) reasons.push(`${plural(liked, 'Liked Song')}`);
      if (recent) reasons.push(`${plural(recent, 'song')} played recently`);
      if (pastFavSongs) reasons.push(`${plural(pastFavSongs, 'past-favorite song')} from earlier eras`);
      if (dormantSongs) reasons.push(`${plural(dormantSongs, 'song')} you haven’t played in 4+ months`);
      if (!reasons.length && node.history?.plays) {
        reasons.push(`${plural(node.history.plays, 'play')} in your streaming history (${node.history.firstEra} – ${node.history.lastEra})`);
      }
      if (!reasons.length) reasons.push('Featured on a song you listen to');
      parts.push(section('Why they’re here', el('ul', { class: 'reason-list' }, reasons.map(r => el('li', { text: r })))));
    }

    if (tracks.length) {
      let songFilter = 'all';
      const songContainer = el('div');
      const collabTracksCount = tracks.filter(t => node.collabTrackIds?.has(t.id) || (t.featArtistIds?.length > 0)).length;
      const renderArtistSongs = () => {
        const list = songFilter === 'all'
          ? tracks
          : (songFilter === 'collabs'
            ? tracks.filter(t => node.collabTrackIds?.has(t.id) || (t.featArtistIds?.length > 0))
            : tracks.filter(t => nodeMatchesLens(t, songFilter)));
        songContainer.replaceChildren(
          list.length
            ? this.songList(list, false, node.id)
            : el('p', { class: 'empty-note', text: 'No songs by this artist match that filter.' })
        );
      };
      renderArtistSongs();

      const filterDefs = [
        { id: 'all', label: `All (${tracks.length})` },
        ...(collabTracksCount > 0 ? [{ id: 'collabs', label: `Collabs (${collabTracksCount})` }] : []),
        ...availableLenses(tracks).map(l => ({ id: l.id, label: l.short }))
      ];

      const filterBar = (tracks.length >= 3 || collabTracksCount > 0) && filterDefs.length > 1
        ? el('div', { class: 'inline-filter-row' }, filterDefs.map(f => el('button', {
          type: 'button',
          class: `mini-pill${f.id === 'all' ? ' is-active' : ''}`,
          text: f.label,
          onclick: (e) => {
            songFilter = f.id;
            [...e.currentTarget.parentElement.children].forEach(b => b.classList.remove('is-active'));
            e.currentTarget.classList.add('is-active');
            renderArtistSongs();
          }
        })))
        : null;

      parts.push(section(`Your songs (${tracks.length})`, el('div', {}, [filterBar, songContainer])));
    } else if (!this.ctx.isDemo()) {
      const note = this.ctx.likedSongsConnected()
        ? 'None of their individual songs had enough plays to form moons, though they appear in your artist listening.'
        : 'None of their songs are in your top songs or recent plays. Liked Songs aren’t connected yet; reconnect Spotify to include them.';
      parts.push(section('Your songs', el('p', { class: 'empty-note', text: note })));
    }

    if (node.subgenres?.length) {
      parts.push(section('Genres', el('div', {}, [
        el('div', { class: 'chips' }, node.subgenres.map(g => el('span', { class: 'chip', text: g }))),
        this.ctx.isDemo() ? null : el('p', { class: 'source-note', text: 'From Last.fm, Wikidata and MusicBrainz.' })
      ])));
    } else if (!this.ctx.isDemo()) {
      const note = node.doubtedTags?.length
        ? `Last.fm tags this name as ${node.doubtedTags.join(', ')}, which doesn’t match anything you play it with, so those tags probably belong to another artist with the same name. They’re placed by the artists you play alongside them instead.`
        : 'No genre data found for this artist yet, so they’re placed by home country, collaborations and the artists you play alongside them.';
      parts.push(section('Genres', el('p', { class: 'empty-note', text: note })));
    }

    parts.push(this.actions(node));
    this.container.append(...parts);
  }

  renderSong(node) {
    const artist = this.ctx.resolve(node.artistId);
    const featList = [...new Set([...(node.featArtistIds || []), ...(node.featArtistId ? [node.featArtistId] : [])])]
      .filter(id => id && id !== node.artistId)
      .map(id => this.ctx.resolve(id))
      .filter(Boolean);
    const clusters = artist ? [...(artist.neighbors || [])].map(id => this.ctx.resolve(id)).filter(n => n && n.type === 'genre') : [];

    const byChildren = [
      'by ',
      artist ? el('button', { type: 'button', text: artist.name, onclick: () => this.ctx.onSelect(artist) }) : (node.artistName || 'unknown artist')
    ];
    if (featList.length) {
      byChildren.push(' with ');
      featList.forEach((fa, idx) => {
        if (idx > 0) byChildren.push(', ');
        byChildren.push(el('button', { type: 'button', text: fa.name, onclick: () => this.ctx.onSelect(fa) }));
      });
    }

    const parts = [
      el('p', { class: 'detail-kind', text: ['Song', formatDuration(node.durationMs)].filter(Boolean).join(', ') }),
      el('h2', { class: 'detail-title', text: node.name }),
      el('p', { class: 'detail-by' }, byChildren)
    ];
    if (clusters.length) {
      parts.push(el('div', { class: 'chips', style: 'margin-top:10px' }, clusters.map(c => this.chipFor(c))));
    }

    const histCard = renderHistoryCard(node);
    if (histCard) parts.push(histCard);

    if (!this.ctx.isDemo()) {
      const reasons = RANGE_ORDER
        .filter(r => node.ranks?.[r])
        .map(r => `Top song, ${RANGE_LABEL[r]} (#${node.ranks[r]})`);
      if (node.liked) reasons.push('In your Liked Songs');
      if (node.recentPlays) reasons.push(node.recentPlays > 1 ? `Played ${node.recentPlays} times recently` : 'Played recently');
      if (node.history?.plays) {
        reasons.push(`Played ${plural(node.history.plays, 'time')} (${formatListeningTime(node.history.minutes)}) in your streaming history`);
      }
      if (reasons.length) parts.push(section('Why it’s here', el('ul', { class: 'reason-list' }, reasons.map(r => el('li', { text: r })))));
    }

    parts.push(this.actions(node));
    this.container.append(...parts);
  }
}
