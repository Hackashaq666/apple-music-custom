/**
 * am-search-card.js  –  Apple Music Search Card for Home Assistant
 *
 * Konfiguration in Lovelace:
 *   type:   custom:am-search-card
 *   entity: media_player.am_apple_music   (Pflicht)
 *   title:  "Apple Music"                  (optional)
 *
 * Deployment:
 *   1. Datei nach /config/www/am-search-card.js kopieren
 *   2. In HA unter Einstellungen → Dashboards → Ressourcen hinzufügen:
 *      URL: /local/am-search-card.js  |  Typ: JavaScript-Modul
 */

const FILTERS = [
  { id: 'all',      label: 'Alle',      classes: [] },
  { id: 'track',    label: 'Track',     classes: ['track'] },
  { id: 'album',    label: 'Album',     classes: ['album'] },
  { id: 'artist',   label: 'Künstler',  classes: ['artist'] },
  { id: 'playlist', label: 'Playlist',  classes: ['playlist'] },
];

const MEDIA_ICONS = {
  track:    'mdi:music-note',
  album:    'mdi:album',
  artist:   'mdi:account-music',
  playlist: 'mdi:playlist-music',
};

const MEDIA_LABELS = {
  track: 'Track', album: 'Album', artist: 'Künstler', playlist: 'Playlist',
};

// ──────────────────────────────────────────────────────────────────────────────

class AmSearchCard extends HTMLElement {
  constructor() {
    super();
    this._hass        = null;
    this._config      = {};
    this._filter      = 'all';
    this._debounce    = null;
    this._built       = false;
    this._loading     = false;
    this._error       = '';
    this._includeVideos  = true;   // Musikvideos in Suchergebnissen anzeigen
    this._progressTimer  = null;  // setInterval für live Fortschrittsanzeige
    this._seekOverride   = null;  // sofortiges visuelles Feedback nach Seek
    this._playingContext = null;  // track | album | artist | playlist
    // Navigation-Stack: jeder Eintrag = { title, items, isSearch? }
    this._navStack    = [];
  }

  // ── Lovelace lifecycle ──────────────────────────────────────────────────────

  setConfig(config) {
    if (!config.entity) throw new Error('am-search-card: "entity" ist erforderlich');
    this._config = { title: 'Apple Music', ...config };
    this._build();
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!this._built) return;
    const id = this._config?.entity;
    if (!id) return;
    const ns = hass?.states?.[id];
    const os = prev?.states?.[id];
    if (ns?.state !== os?.state ||
        ns?.attributes?.media_title !== os?.attributes?.media_title ||
        ns?.attributes?.entity_picture !== os?.attributes?.entity_picture ||
        ns?.attributes?.volume_level !== os?.attributes?.volume_level ||
        ns?.attributes?.is_volume_muted !== os?.attributes?.is_volume_muted ||
        ns?.attributes?.media_duration !== os?.attributes?.media_duration ||
        ns?.attributes?.shuffle !== os?.attributes?.shuffle ||
        ns?.attributes?.repeat !== os?.attributes?.repeat) {
      this._renderNowPlaying();
    }
  }

  getCardSize() { return 5; }

  // ── Card config editor (getConfigElement) ───────────────────────────────────
  // Returns a custom editor element so HA shows the full tabbed dialog:
  // Konfiguration | Sichtbarkeit | Layout
  // Without this, HA falls back to YAML-only and omits the Layout tab.
  static getConfigElement() {
    return document.createElement('am-search-card-editor');
  }

  // Default config when card is added via the card picker
  static getStubConfig(hass) {
    const first = Object.keys(hass?.states || {}).find(
      (id) => id.startsWith('media_player.')
    );
    return { entity: first || 'media_player.am_apple_music', title: 'Apple Music' };
  }

  // Standard HA 2026.6: defines default/min/max size in the sections grid (12 cols per section).
  // Users can resize via the Layout tab in the card editor or with grid_options in YAML:
  //   grid_options:
  //     columns: 6   # 1–12
  //     rows: 5      # number of row-units (~56px each)
  getGridOptions() {
    // Sections view grid: each row = 56px height + 8px gap
    // rows:8 = 8*56 + 7*8 = 504px → ~340px for the results list
    // (header ~50px + search ~60px + chips ~35px + padding ~20px = ~165px overhead)
    return {
      columns:     12,   // default: full section width
      min_columns:  4,   // narrowest useful layout
      rows:         8,   // default: 504px total, ~340px for results
      min_rows:     4,   // minimum: ~260px total, ~95px for results
    };
  }

  // ── Initial DOM build (einmalig) ────────────────────────────────────────────

  _build() {
    if (this._built) return;
    this._built = true;

    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>${CSS_STYLES}</style>${CARD_HTML}`;

    const s = this.shadowRoot;

    // Header-Titel setzen
    s.querySelector('.header-title').textContent = this._config.title;

    // ── Suchfeld ──────────────────────────────────────────────────────────────
    const input   = s.querySelector('.search-input');
    const clearBtn = s.querySelector('.clear-btn');

    // Show/hide clear button based on input content
    const updateClearBtn = () => {
      clearBtn.classList.toggle('hidden', !input.value && this._navStack.length <= 1);
    };

    // Clear button click handler
    clearBtn.addEventListener('click', () => {
      input.value = '';
      updateClearBtn();
      clearTimeout(this._debounce);
      this._navStack = [];
      this._renderView();
      input.focus();
    });

    input.addEventListener('input', () => {
      updateClearBtn();
      clearTimeout(this._debounce);
      const q = input.value.trim();
      if (!q) {
        if (this._filter === 'playlist') {
          this._loadAllPlaylists();
        } else {
          this._navStack = [];
          this._renderView();
        }
        return;
      }
      this._debounce = setTimeout(() => this._doSearch(q), 350);
    });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      clearTimeout(this._debounce);
      const q = input.value.trim();
      if (q) this._doSearch(q);
    });

    // Video-Toggle Checkbox
    const videoCb = s.querySelector('.include-videos-cb');
    videoCb.addEventListener('change', () => {
      this._includeVideos = videoCb.checked;
      this._renderView();
    });

    // ── Filter-Chips ──────────────────────────────────────────────────────────
    s.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        s.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this._filter = chip.dataset.filter;
        const q = input.value.trim();
        if (q) {
          this._doSearch(q);
        } else if (this._filter === 'playlist') {
          this._loadAllPlaylists();
        } else {
          this._navStack = [];
          this._renderView();
        }
      });
    });

    // ── Zurück-Button ─────────────────────────────────────────────────────────
    // Now-playing transport controls
    // Repeat toggle (off → all → one → off)
    s.querySelector('.np-repeat').addEventListener('click', () => {
      if (!this._hass) return;
      const st = this._hass.states?.[this._config.entity];
      const cur = st?.attributes?.repeat || 'off';
      const next = cur === 'off' ? 'all' : cur === 'all' ? 'one' : 'off';
      this._hass.callService('media_player', 'repeat_set', {
        entity_id: this._config.entity,
        repeat: next,
      });
    });

    // Shuffle toggle
    s.querySelector('.np-shuffle').addEventListener('click', () => {
      if (!this._hass) return;
      const st = this._hass.states?.[this._config.entity];
      const shuffleOn = st?.attributes?.shuffle === true;
      this._hass.callService('media_player', 'shuffle_set', {
        entity_id: this._config.entity,
        shuffle: !shuffleOn,
      });
    });

    s.querySelector('.np-prev').addEventListener('click', () => {
      if (!this._hass) return;
      this._hass.callService('media_player', 'media_previous_track', {
        entity_id: this._config.entity,
      });
    });
    s.querySelector('.np-next').addEventListener('click', () => {
      if (!this._hass) return;
      this._hass.callService('media_player', 'media_next_track', {
        entity_id: this._config.entity,
      });
    });
    // Now-playing play/pause
    s.querySelector('.np-playpause').addEventListener('click', () => {
      if (!this._hass) return;
      this._hass.callService('media_player', 'media_play_pause', {
        entity_id: this._config.entity,
      });
    });

    // Volume slider
    const volSlider = s.querySelector('.np-vol-slider');
    const updateVolFill = (val) => {
      volSlider.style.background =
        `linear-gradient(to right, #fc3c44 0%, #fc3c44 ${val}%, rgba(255,255,255,.2) ${val}%)`;
    };
    volSlider.addEventListener('input', () => updateVolFill(volSlider.value));
    volSlider.addEventListener('change', () => {
      if (!this._hass) return;
      this._hass.callService('media_player', 'volume_set', {
        entity_id: this._config.entity,
        volume_level: parseFloat(volSlider.value) / 100,
      });
    });

    // Mute toggle – via volume_set (zuverlässig, da volume_mute keine HA-State-Änderung auslöst)
    // Vorherige Lautstärke wird clientseitig gespeichert und bei Demute wiederhergestellt.
    s.querySelector('.np-vol-btn').addEventListener('click', () => {
      if (!this._hass) return;
      const st  = this._hass.states?.[this._config.entity];
      const vol = st?.attributes?.volume_level ?? 0.5;
      const isMuted = vol === 0 || st?.attributes?.is_volume_muted === true;
      if (isMuted) {
        // Demute: gespeicherten Pegel wiederherstellen (Fallback 0.5)
        const restore = this._premuteVol ?? 0.5;
        this._premuteVol = null;
        this._hass.callService('media_player', 'volume_set', {
          entity_id: this._config.entity,
          volume_level: restore,
        });
      } else {
        // Mute: aktuellen Pegel merken, dann auf 0 setzen
        this._premuteVol = vol;
        this._hass.callService('media_player', 'volume_set', {
          entity_id: this._config.entity,
          volume_level: 0,
        });
      }
    });

    // Progress bar – Klick = Seek (mit sofortigem visuellem Feedback)
    s.querySelector('.np-progress-bar').addEventListener('click', (e) => {
      if (!this._hass) return;
      const st       = this._hass.states?.[this._config.entity];
      const duration = st?.attributes?.media_duration ?? 0;
      if (!duration) return;
      const rect    = e.currentTarget.getBoundingClientRect();
      const pct     = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
      const seekPos = pct * duration;
      // Sofortiges visuelles Feedback – Override gilt bis HA-State aktualisiert
      this._seekOverride = { position: seekPos, setAt: Date.now() };
      this._updateProgressBar();
      this._hass.callService('media_player', 'media_seek', {
        entity_id:     this._config.entity,
        seek_position: seekPos,
      });
    });

    s.querySelector('.play-all-btn').addEventListener('click', () => this._playAll());

    // More Info Dialog
    s.querySelector('.more-info-btn').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('hass-more-info', {
        bubbles: true, composed: true,
        detail: { entityId: this._config.entity },
      }));
    });

    s.querySelector('.back-btn').addEventListener('click', () => {
      if (this._navStack.length > 1) {
        this._navStack.pop();
        this._renderView();
      }
    });
  }

  // ── Musikvideo-Filter ────────────────────────────────────────────────────────
  // mediaKind ist Teil der content_id: track||id||artist||album||mediaKind (5. Teil)
  _filterVideos(items) {
    if (this._includeVideos) return items;
    return items.filter(i => {
      const cid   = i.media_content_id || '';
      const parts = cid.split('||');
      if (parts[0] === 'track')    return parts[4] !== 'music video'; // track||id||artist||album||mediaKind
      if (parts[0] === 'album')    return parts[3] !== 'music video'; // album||artist||name||mediaKind
      if (parts[0] === 'playlist') return parts[2] !== 'music video'; // playlist||id||mediaKind
      if (parts[0] === 'artist')   return parts[2] !== 'music video'; // artist||name||mediaKind
      return true;
    });
  }

  // ── Hilfs-Methoden für Fortschrittsanzeige ──────────────────────────────────

  _formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  _getCurrentPosition() {
    const st = this._hass?.states?.[this._config?.entity];
    // Seek-Override: lokale Position nutzen bis HA-State aktueller als der Seek-Zeitpunkt
    if (this._seekOverride) {
      const updatedAt = st?.attributes?.media_position_updated_at;
      if (updatedAt && new Date(updatedAt).getTime() > this._seekOverride.setAt) {
        this._seekOverride = null; // HA-State ist frischer → Override verwerfen
      } else {
        const elapsed = (Date.now() - this._seekOverride.setAt) / 1000;
        return this._seekOverride.position + elapsed;
      }
    }
    if (!st) return 0;
    const pos       = st.attributes?.media_position ?? 0;
    const updatedAt = st.attributes?.media_position_updated_at;
    if (st.state === 'playing' && updatedAt) {
      return pos + (Date.now() - new Date(updatedAt).getTime()) / 1000;
    }
    return pos;
  }

  _updateProgressBar() {
    const s = this.shadowRoot;
    if (!s) return;
    const fill     = s.querySelector('.np-progress-fill');
    const durLabel = s.querySelector('.np-duration');
    if (!fill || !durLabel) return;
    const st       = this._hass?.states?.[this._config?.entity];
    if (!st) return;
    const duration = st.attributes?.media_duration ?? 0;
    const position = this._getCurrentPosition();
    const pct      = duration > 0 ? Math.min((position / duration) * 100, 100) : 0;
    fill.style.width   = `${pct}%`;
    durLabel.textContent = duration > 0 ? this._formatTime(duration) : '';
  }

  // ── Now-Playing-Sektion ─────────────────────────────────────────────────────

  _renderNowPlaying() {
    const s = this.shadowRoot;
    if (!s) return;
    const state  = this._hass?.states?.[this._config?.entity];
    const np     = s.querySelector('.now-playing');
    if (!np) return;
    const active = state?.state === 'playing' || state?.state === 'paused';
    np.classList.toggle('hidden', !active);
    if (!active) return;
    const a = state.attributes;
    const cover = s.querySelector('.np-cover');
    if (a.entity_picture) { cover.src = a.entity_picture; cover.style.display = 'block'; }
    else { cover.style.display = 'none'; }
    s.querySelector('.np-title').textContent  = a.media_title  || '';
    s.querySelector('.np-artist').textContent = a.media_artist || '';
    const ctxEl  = s.querySelector('.np-context');
    const ctxMap = { track: 'Track', album: 'Album', artist: 'Künstler', playlist: 'Playlist', search_results: 'Suche' };
    const ctxTxt = ctxMap[this._playingContext] || '';
    if (ctxEl) {
      ctxEl.textContent = ctxTxt;
      ctxEl.classList.toggle('hidden', !ctxTxt);
    }
    s.querySelector('.np-playpause ha-icon').setAttribute(
      'icon', state.state === 'playing' ? 'mdi:pause' : 'mdi:play'
    );
    // Shuffle-Button: aktiv (rot) wenn shuffle an
    const shuffleBtn = s.querySelector('.np-shuffle');
    // Repeat-Button: Icon + Farbe je nach Zustand
    const repeatBtn = s.querySelector('.np-repeat');
    if (repeatBtn) {
      const repeat = a.repeat || 'off';
      const repeatIcon = repeat === 'one' ? 'mdi:repeat-once' : repeat === 'all' ? 'mdi:repeat' : 'mdi:repeat-off';
      repeatBtn.querySelector('ha-icon').setAttribute('icon', repeatIcon);
      repeatBtn.classList.toggle('active', repeat !== 'off');
    }

    if (shuffleBtn) {
      shuffleBtn.classList.toggle('active', a.shuffle === true);
      shuffleBtn.querySelector('ha-icon').setAttribute(
        'icon', a.shuffle === true ? 'mdi:shuffle' : 'mdi:shuffle-disabled'
      );
    }
    // Sync volume slider
    const vol   = a.volume_level != null ? Math.round(a.volume_level * 100) : 50;
    const vSldr = s.querySelector('.np-vol-slider');
    if (vSldr) {
      vSldr.value = vol;
      vSldr.style.background =
        `linear-gradient(to right, #fc3c44 0%, #fc3c44 ${vol}%, rgba(255,255,255,.2) ${vol}%)`;
    }
    // Fortschritts-Timer starten/stoppen
    if (state.state === 'playing') {
      if (!this._progressTimer) {
        this._progressTimer = setInterval(() => this._updateProgressBar(), 250);
      }
    } else {
      if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
    }
    this._updateProgressBar();

    // Volume icon: mdi:volume-off when muted or vol=0
    const isMuted = a.is_volume_muted === true || vol === 0;
    const volIconEl = s.querySelector('.np-vol-icon');
    if (volIconEl) {
      volIconEl.setAttribute('icon', isMuted ? 'mdi:volume-off' : 'mdi:volume-high');
    }
  }

  // ── Alle Playlists laden (wenn Filter=Playlist ohne Sucheingabe) ─────────────

  async _loadAllPlaylists() {
    this._loading = true;
    this._error   = '';
    this._renderLoading();
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type:               'media_player/browse_media',
        entity_id:          this._config.entity,
        media_content_type: 'playlist',
        media_content_id:   'playlists',
      });
      const items = res?.children ?? [];
      this._navStack = [{ title: 'Playlists', items }];
      this._renderView();
    } catch (e) {
      this._error = 'Playlists konnten nicht geladen werden: ' + (e?.message ?? e);
      this._renderError();
    } finally {
      this._loading = false;
    }
  }

  // ── Suche (via HA WebSocket / callService return_response) ──────────────────

  async _doSearch(query) {
    this._loading = true;
    this._error   = '';
    this._renderLoading();

    const filter      = FILTERS.find(f => f.id === this._filter);
    const serviceData = { entity_id: this._config.entity, search_query: query };
    if (filter?.classes.length) serviceData.media_filter_classes = filter.classes;

    try {
      const res = await this._hass.connection.sendMessagePromise({
        type:             'call_service',
        domain:           'media_player',
        service:          'search_media',
        service_data:     serviceData,
        return_response:  true,
      });
      const items = res?.response?.[this._config.entity]?.result ?? [];
      this._navStack = [{ title: `"${query}"`, items, isSearch: true }];
      this._renderView();
    } catch (e) {
      this._error = 'Suche fehlgeschlagen: ' + (e?.message ?? e);
      this._renderError();
    } finally {
      this._loading = false;
    }
  }

  // ── Browse (Drill-down für Album / Artist) ──────────────────────────────────

  async _browseTo(item) {
    this._loading = true;
    this._renderLoading();
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type:               'media_player/browse_media',
        entity_id:          this._config.entity,
        media_content_type: item.media_content_type,
        media_content_id:   item.media_content_id,
      });
      const children = res?.children ?? [];
      const title    = item.title.split(' — ')[0] || item.title;
      this._navStack.push({ title, items: children, thumbnail: item.thumbnail, sourceItem: item });
      this._renderView();
    } catch (e) {
      this._error = 'Inhalt konnte nicht geladen werden: ' + (e?.message ?? e);
      this._renderError();
    } finally {
      this._loading = false;
    }
  }

  // ── Alle Tracks spielen (HA_Play_Search) ────────────────────────────────────

  async _playAll() {
    if (!this._hass) return;
    const depth = this._navStack.length;
    if (!depth) return;
    const view  = this._navStack[depth - 1];
    const items = view.items ?? [];

    const collected = []; // final ordered list of track IDs

    const browse = (item) => this._hass.connection.sendMessagePromise({
      type:               'media_player/browse_media',
      entity_id:          this._config.entity,
      media_content_type: item.media_content_type,
      media_content_id:   item.media_content_id,
    });
    const extractId = (t) => (t.media_content_id || '').split('||')[1] || '';
    // Phase-2-Video-Filter: track||id||artist||album||mediaKind → parts[4]
    const isVideo = (t) => {
      if (this._includeVideos) return false;
      return (t.media_content_id || '').split('||')[4] === 'music video';
    };

    // Phase 1: Direkte Tracks – nach Album gruppiert (Video-Filter angewendet)
    // content_id-Format: track||id||albumArtist||album||mediaKind
    const filteredItems = this._filterVideos(items);
    const albumGroups = new Map();
    filteredItems.filter(i => i.can_play && (
      String(i.media_class).includes('track') ||
      String(i.media_content_type).includes('track') ||
      String(i.media_content_id).startsWith('track')
    )).forEach(i => {
      const parts = (i.media_content_id || '').split('||');
      const id = parts[1]; if (!id) return;
      const key = parts[3] || '_unknown'; // Album-Name als Schlüssel (nicht albumArtist+album)
      // → Compilation-Tracks mit unterschiedlichem albumArtist landen in derselben Gruppe
      if (!albumGroups.has(key)) albumGroups.set(key, []);
      albumGroups.get(key).push(id);
    });
    [...albumGroups.keys()].sort().forEach(k =>
      albumGroups.get(k).forEach(id => collected.push(id))
    );

    // Phase 2: Artists/Alben sequenziell expandieren → Album-Reihenfolge erhalten
    const expandable = filteredItems.filter(i =>
      String(i.media_content_id).startsWith('artist||') ||
      String(i.media_content_id).startsWith('album||')
    );

    if (expandable.length > 0) {
      this._renderLoading();
      for (const item of expandable) {
        try {
          const res = await browse(item);
          const children = res?.children ?? [];
          if (String(item.media_content_id).startsWith('artist||')) {
            // Artist → sequenziell Album für Album expandieren
            for (const album of children) {
              try {
                const ar = await browse(album);
                (ar?.children ?? []).forEach(t => { if (isVideo(t)) return; const id = extractId(t); if (id) collected.push(id); });
              } catch (e) {}
            }
          } else {
            // Album → direkt Tracks in korrekter Reihenfolge
            children.forEach(t => { if (isVideo(t)) return; const id = extractId(t); if (id) collected.push(id); });
          }
        } catch (e) {}
      }
    }

    if (collected.length > 0) {
      // Deduplizieren: Tracks die in Phase 1 UND Phase 2 vorkommen, nur einmal behalten
      const seenIds = new Set();
      const deduped = collected.filter(id => {
        if (seenIds.has(id)) return false;
        seenIds.add(id); return true;
      });
      this._hass.callService('media_player', 'play_media', {
        entity_id:          this._config.entity,
        media_content_type: 'search_results',
        media_content_id:   'search_results||' + deduped.join('||'),
      });
      // Repeat auf "off" zurücksetzen wenn neue Suche gestartet wird
      this._hass.callService('media_player', 'repeat_set', {
        entity_id: this._config.entity,
        repeat: 'off',
      });
      this._playingContext = 'search_results';
      this._renderView();
      return;
    }

    // Fallback: Quell-Item direkt spielen (Artist-Drill-down-Kontext)
    const src = view.sourceItem;
    if (src && src.can_play) {
      this._play(src);
      this._playingContext = src.media_class || null;
    }
  }

  // ── Abspielen ─────────────────────────────────────────────────────────────

  _play(item) {
    if (!this._hass || !item.can_play) return;
    this._playingContext = item.media_class || null;
    this._hass.callService('media_player', 'play_media', {
      entity_id:          this._config.entity,
      media_content_type: item.media_content_type,
      media_content_id:   item.media_content_id,
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _renderView() {
    const s        = this.shadowRoot;
    const depth    = this._navStack.length;
    const backBtn  = s.querySelector('.back-btn');
    const logoIcon = s.querySelector('.logo');
    const searchArea = s.querySelector('.search-area');
    const statusBar  = s.querySelector('.status-bar');
    const headerTitle = s.querySelector('.header-title');

    // UI-Zustand je nach Navigationstiefe
    const inBrowse = depth > 1;
    backBtn.classList.toggle('hidden', !inBrowse);
    logoIcon.classList.toggle('hidden', inBrowse);
    // search area always visible (X button handles drill-up when inBrowse)
    statusBar.textContent = '';
    statusBar.style.color = '';

    if (inBrowse) {
      headerTitle.textContent = this._navStack[depth - 1].title;
    } else {
      headerTitle.textContent = this._config.title;
    }

    if (depth === 0) {
      s.querySelector('.items-list').innerHTML = '';
      s.querySelector('.play-all-btn')?.classList.add('hidden');
      return;
    }
    const currentItems = this._navStack[depth - 1].items ?? [];
    // Play-All-Button immer sichtbar wenn Ergebnisse vorhanden –
    // _playAll() filtert intern auf Track-IDs
    s.querySelector('.play-all-btn')?.classList.toggle('hidden', currentItems.length === 0);
    this._renderItems(this._filterVideos(currentItems));
  }

  _renderItems(items) {
    const list = this.shadowRoot.querySelector('.items-list');

    if (!items.length) {
      list.innerHTML = `<div class="empty"><ha-icon icon="mdi:music-off"></ha-icon><span>Keine Ergebnisse</span></div>`;
      return;
    }

    list.innerHTML = items.map((item, idx) => {
      const icon     = MEDIA_ICONS[item.media_class] || 'mdi:music';
      const subLabel = item.title.includes(' — ')
        ? item.title.split(' — ').slice(1).join(' — ')
        : (MEDIA_LABELS[item.media_class] || item.media_class);
      const mainTitle = item.title.includes(' — ')
        ? item.title.split(' — ')[0]
        : item.title;

      return `
        <div class="item" data-idx="${idx}">
          <div class="thumb-wrap">
            ${item.thumbnail
              ? `<img class="thumb" src="${this._esc(item.thumbnail)}" alt="" />
                 <div class="thumb-ph hidden">${this._iconEl(icon)}</div>`
              : `<div class="thumb-ph">${this._iconEl(icon)}</div>`
            }
          </div>
          <div class="item-info">
            <span class="item-title" title="${this._esc(item.title)}">${this._esc(mainTitle)}</span>
            <span class="item-sub">${this._esc(subLabel)}</span>
          </div>
          <div class="item-actions">
            ${item.can_expand
              ? `<button class="action-btn expand-btn" title="Inhalt anzeigen">${this._iconEl('mdi:chevron-right')}</button>`
              : ''}
            ${item.can_play
              ? `<button class="action-btn play-btn" title="Abspielen">${this._iconEl('mdi:play-circle-outline')}</button>`
              : ''}
          </div>
        </div>`;
    }).join('');

    // Hinweis wenn Server-Limit (100 pro Kategorie) möglicherweise erreicht wurde
    if (items.length >= 100) {
      const hint = document.createElement('div');
      hint.className = 'truncation-hint';
      hint.textContent = 'Ergebnisse auf 100 begrenzt – bitte Suche verfeinern.';
      list.appendChild(hint);
    }

    // Event-Listener und Bild-Fehlerbehandlung
    list.querySelectorAll('.item').forEach((el, idx) => {
      const item = items[idx];

      // Bild-Fallback: bei Ladefehler Placeholder zeigen
      const img = el.querySelector('.thumb');
      if (img) {
        img.addEventListener('error', () => {
          img.style.display = 'none';
          const ph = el.querySelector('.thumb-ph.hidden');
          if (ph) ph.classList.remove('hidden');
        });
      }

      // Play-Button
      const playBtn = el.querySelector('.play-btn');
      if (playBtn) {
        playBtn.addEventListener('click', e => {
          e.stopPropagation();
          this._play(item);
          this._flash(el);
        });
      }

      // Expand-Button (Drill-down)
      const expandBtn = el.querySelector('.expand-btn');
      if (expandBtn) {
        expandBtn.addEventListener('click', e => {
          e.stopPropagation();
          this._browseTo(item);
        });
      }

      // Klick auf die ganze Zeile: Drill-down > Play > nichts
      el.addEventListener('click', () => {
        if (item.can_expand) this._browseTo(item);
        else if (item.can_play) { this._play(item); this._flash(el); }
      });
    });
  }

  _renderLoading() {
    this.shadowRoot.querySelector('.items-list').innerHTML =
      `<div class="loading">${this._iconEl('mdi:loading', 'spin')}<span>Laden…</span></div>`;
    this.shadowRoot.querySelector('.status-bar').textContent = '';
  }

  _renderError() {
    this.shadowRoot.querySelector('.items-list').innerHTML = '';
    const sb = this.shadowRoot.querySelector('.status-bar');
    sb.textContent  = this._error;
    sb.style.color  = 'var(--error-color, #f44336)';
  }

  // ── Kleine Helfer ─────────────────────────────────────────────────────────

  _flash(el) {
    el.classList.add('played');
    setTimeout(() => el.classList.remove('played'), 600);
  }

  _iconEl(icon, extraClass = '') {
    return `<ha-icon icon="${icon}"${extraClass ? ` class="${extraClass}"` : ''}></ha-icon>`;
  }

  _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}

// ── Statischer HTML-Template-String ──────────────────────────────────────────

const CARD_HTML = `
<ha-card>
  <div class="now-playing hidden">
    <div class="np-content">
      <div class="np-cover-wrap">
        <img class="np-cover" src="" alt="" />
      </div>
      <div class="np-controls">
        <div class="np-info">
          <span class="np-title"></span>
          <span class="np-artist"></span>
          <span class="np-context hidden"></span>
        </div>
        <div class="np-playback">
          <div class="np-transport">
            <button class="np-prev" title="Vorheriger Titel">
              <ha-icon icon="mdi:skip-previous"></ha-icon>
            </button>
            <button class="np-playpause" title="Play/Pause">
              <ha-icon icon="mdi:pause"></ha-icon>
            </button>
            <button class="np-next" title="Nächster Titel">
              <ha-icon icon="mdi:skip-next"></ha-icon>
            </button>
          </div>
          <div class="np-shuffle-row">
            <button class="np-shuffle" title="Zufallswiedergabe">
              <ha-icon icon="mdi:shuffle-disabled"></ha-icon>
            </button>
            <button class="np-repeat" title="Wiederholen">
              <ha-icon icon="mdi:repeat-off"></ha-icon>
            </button>
          </div>
        </div>
        <div class="np-volume">
          <button class="np-vol-btn" title="Stummschalten">
            <ha-icon icon="mdi:volume-high" class="np-vol-icon"></ha-icon>
          </button>
          <input type="range" class="np-vol-slider" min="0" max="100" value="50" />
        </div>
      </div>
    </div>
    <div class="np-progress-wrap">
      <div class="np-progress-bar">
        <div class="np-progress-fill"></div>
      </div>
      <span class="np-duration">0:00</span>
    </div>
    <div class="np-divider"></div>
  </div>
  <div class="card-header">
    <div class="header-left">
      <button class="back-btn hidden" title="Zurück">
        <ha-icon icon="mdi:arrow-left"></ha-icon>
      </button>
      <ha-icon class="logo" icon="mdi:music-circle"></ha-icon>
      <span class="header-title"></span>
    </div>
    <button class="more-info-btn" title="Mehr Informationen">
      <ha-icon icon="mdi:information-outline"></ha-icon>
    </button>
  </div>

  <div class="search-area">
    <div class="search-row">
      <ha-icon icon="mdi:magnify" class="search-icon"></ha-icon>
      <input class="search-input" type="search" placeholder="Suchen…"
             autocomplete="off" spellcheck="false" />
      <button class="clear-btn hidden" title="Löschen" tabindex="-1">
        <ha-icon icon="mdi:close-circle"></ha-icon>
      </button>
    </div>
    <div class="video-toggle">
      <label class="video-toggle-label">
        <input type="checkbox" class="include-videos-cb" checked />
        <span>Musikvideos inkludieren</span>
      </label>
    </div>
    <div class="chips">
      ${FILTERS.map(f =>
        `<button class="chip${f.id === 'all' ? ' active' : ''}" data-filter="${f.id}">${f.label}</button>`
      ).join('')}
        <button class="play-all-btn hidden" title="Alle Tracks spielen">
          <ha-icon icon="mdi:play-circle-outline"></ha-icon>
        </button>
    </div>
  </div>

  <div class="content">
    <div class="items-list"></div>
    <div class="status-bar"></div>
  </div>
</ha-card>`;

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS_STYLES = `
  :host { display: block; height: 100%; }
  ha-card {
    display: flex; flex-direction: column;
    height: 100%; overflow: hidden;
  }

  /* ── Black card background ── */
  :host { display: block; height: 100%; }
  ha-card {
    display: flex; flex-direction: column;
    height: 100%; overflow: hidden;
    background: #0d0d0d !important;
    color: #f0f0f0;
  }

  .more-info-btn {
    background: none; border: none; cursor: pointer;
    color: rgba(240,240,240,.45); display: flex; align-items: center;
    padding: 4px; border-radius: 50%; margin-left: auto;
    transition: color 0.15s; flex-shrink: 0;
  }
  .more-info-btn:hover { color: #ffffff; }
  .more-info-btn ha-icon { --mdc-icon-size: 18px; }

  /* ── Now Playing ── */
  .now-playing { padding: 14px 16px 0; }
  .np-content {
    display: flex; flex-direction: row;
    align-items: center; gap: 14px;
    padding: 4px 0 12px;
  }
  .np-cover-wrap {
    width: 200px; height: 200px; flex-shrink: 0;
    border-radius: 10px; overflow: hidden;
    background: #1a1a1a;
    box-shadow: 0 6px 24px rgba(0,0,0,.5);
  }
  .np-cover { width: 100%; height: 100%; object-fit: cover; display: block; }
  .np-controls {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column;
    align-items: flex-start; justify-content: center;
    gap: 12px;
  }
  .np-info {
    display: flex; flex-direction: column; gap: 3px;
    width: 100%;
  }
  .np-title {
    font-size: 0.9em; font-weight: 600; color: #f0f0f0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .np-artist {
    font-size: 0.76em; color: rgba(240,240,240,0.6);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .np-playback { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .np-transport { display: flex; align-items: center; gap: 2px; }
  .np-shuffle-row { display: flex; gap: 8px; }
  .np-shuffle {
    background: none; border: none; cursor: pointer;
    color: rgba(240,240,240,.4); display: flex; align-items: center;
    padding: 3px; border-radius: 50%; transition: color 0.15s;
  }
  .np-shuffle.active { color: #fc3c44; }
  .np-shuffle:hover { color: rgba(240,240,240,.8); }
  .np-shuffle ha-icon { --mdc-icon-size: 18px; }
  .np-repeat {
    background: none; border: none; cursor: pointer;
    color: rgba(240,240,240,.4); display: flex; align-items: center;
    padding: 3px; border-radius: 50%; transition: color 0.15s;
  }
  .np-repeat.active { color: #fc3c44; }
  .np-repeat:hover { color: rgba(240,240,240,.8); }
  .np-repeat ha-icon { --mdc-icon-size: 18px; }
  .np-prev, .np-next {
    background: none; border: none; cursor: pointer;
    color: rgba(240,240,240,.6); display: flex; align-items: center;
    padding: 5px; border-radius: 50%; transition: color 0.15s;
  }
  .np-prev:hover, .np-next:hover { color: #ffffff; }
  .np-prev ha-icon, .np-next ha-icon { --mdc-icon-size: 28px; }
  .np-playpause {
    background: none; border: none; cursor: pointer;
    color: #fc3c44; display: flex; align-items: center;
    padding: 5px; border-radius: 50%;
    transition: background 0.15s;
  }
  .np-playpause:hover { background: rgba(252,60,68,.15); }
  .np-playpause ha-icon { --mdc-icon-size: 32px; }
  .np-volume {
    display: flex; align-items: center; gap: 6px;
    width: 100%;
  }
  .np-context {
    font-size: 0.62em;
    color: rgba(240,240,240,.38);
    letter-spacing: 0.04em;
    font-weight: 500;
  }
  .np-vol-btn {
    background: none; border: none; cursor: pointer;
    color: rgba(240,240,240,.55); display: flex; align-items: center;
    padding: 3px; border-radius: 50%; flex-shrink: 0;
    transition: color 0.15s;
  }
  .np-vol-btn:hover { color: #ffffff; }
  .np-vol-icon { --mdc-icon-size: 22px; }
  .np-vol-slider {
    -webkit-appearance: none; appearance: none;
    width: 130px; max-width: 130px; flex-shrink: 0;
    height: 3px; border-radius: 2px; outline: none; cursor: pointer;
    background: linear-gradient(to right, #fc3c44 50%, rgba(255,255,255,0.2) 50%);
  }
  .np-vol-slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 13px; height: 13px; border-radius: 50%;
    background: #fc3c44; cursor: pointer;
    box-shadow: 0 1px 4px rgba(0,0,0,.4);
  }
  .np-vol-slider::-moz-range-thumb {
    width: 13px; height: 13px; border-radius: 50%;
    background: #fc3c44; cursor: pointer; border: none;
  }
  .np-progress-wrap {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0 10px;
  }
  .np-progress-bar {
    flex: 1; height: 3px; border-radius: 2px;
    background: rgba(255,255,255,.18); cursor: pointer;
    position: relative; transition: height 0.15s;
  }
  .np-progress-bar:hover { height: 7px; }
  .np-progress-fill {
    height: 100%; background: #fc3c44;
    border-radius: 2px; pointer-events: none;
  }
  .np-duration {
    font-size: 0.7em; color: rgba(240,240,240,.5);
    white-space: nowrap; flex-shrink: 0;
    min-width: 32px; text-align: right; font-variant-numeric: tabular-nums;
  }
  .np-divider {
    height: 0.5px; background: rgba(255,255,255,.1);
    margin: 0 -16px;
  }

  /* ── Header ── */
  .card-header {
    display: flex; align-items: center;
    padding: 12px 16px 6px;
  }
  .header-left {
    display: flex; align-items: center; gap: 8px;
    min-width: 0; flex: 1;
  }
  .logo { color: #fc3c44; --mdc-icon-size: 22px; flex-shrink: 0; }
  .header-title {
    font-size: 1em; font-weight: 600;
    color: #f0f0f0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .back-btn {
    background: none; border: none; padding: 4px;
    cursor: pointer; color: var(--primary-color, #fc3c44);
    display: flex; align-items: center; border-radius: 50%;
    transition: background 0.15s; flex-shrink: 0;
  }
  .back-btn:hover { background: rgba(255,255,255,.1); }
  .back-btn ha-icon { --mdc-icon-size: 20px; }
  .hidden { display: none !important; }

  /* ── Suchbereich ── */
  .search-area { padding: 0 12px 8px; }
  .search-row {
    display: flex; align-items: center;
    background: rgba(255,255,255,.08);
    border-radius: 10px; padding: 0 10px; margin-bottom: 8px;
    border: 1.5px solid transparent; transition: border-color 0.15s;
  }
  .search-row:focus-within { border-color: #fc3c44; }
  .search-icon { --mdc-icon-size: 18px; color: rgba(240,240,240,.4); flex-shrink: 0; }
  .search-input {
    flex: 1; border: none; background: transparent;
    color: #f0f0f0;
    font-size: 0.9em; padding: 8px 6px; outline: none; min-width: 0;
  }
  .search-input::placeholder { color: rgba(240,240,240,.4); }
  /* Hide native browser clear button - we use our own */
  .search-input::-webkit-search-cancel-button { -webkit-appearance: none; display: none; }
  .clear-btn {
    background: none; border: none; padding: 2px 4px 2px 0;
    cursor: pointer; display: flex; align-items: center;
    color: rgba(240,240,240,.45); flex-shrink: 0;
    transition: color 0.15s;
  }
  .clear-btn:hover { color: #ffffff; }
  .clear-btn ha-icon { --mdc-icon-size: 16px; }

  /* ── Video-Toggle ── */
  .video-toggle { padding: 0 0 6px; }
  .video-toggle-label {
    display: flex; align-items: center; gap: 6px; cursor: pointer;
    color: rgba(240,240,240,.5); font-size: 0.76em;
  }
  .video-toggle-label:hover { color: rgba(240,240,240,.75); }
  .include-videos-cb { accent-color: #fc3c44; cursor: pointer; width: 13px; height: 13px; }

  /* ── Chips ── */
  .chips { display: flex; gap: 5px; flex-wrap: wrap; }
  .chip {
    padding: 3px 11px;
    border: 1px solid rgba(255,255,255,.25);
    border-radius: 20px; background: transparent;
    color: rgba(240,240,240,.6);
    font-size: 0.78em; font-family: inherit;
    cursor: pointer; transition: all 0.12s; white-space: nowrap;
  }
  .chip:hover:not(.active) {
    border-color: #f0f0f0;
    color: #f0f0f0;
  }
  .chip.active {
    background: #fc3c44; border-color: #fc3c44;
    color: #fff; font-weight: 500;
  }
  .play-all-btn {
    margin-left: auto; background: none; border: none; cursor: pointer;
    color: rgba(240,240,240,.55); display: flex; align-items: center;
    padding: 2px; border-radius: 50%; flex-shrink: 0;
    transition: color 0.12s;
  }
  .play-all-btn:hover { color: #fc3c44; }
  .play-all-btn ha-icon { --mdc-icon-size: 22px; }

  /* ── Ergebnisliste ── */
  .items-list {
    flex: 1; min-height: 80px; max-height: 440px; overflow-y: auto;
    padding: 4px 8px 2px;
    scrollbar-width: thin;
    scrollbar-color: var(--divider-color, rgba(128,128,128,.3)) transparent;
  }
  /* Persistent scrollbar for macOS Safari/Chrome.
     Without ::-webkit-scrollbar-track, macOS uses overlay scrollbars
     that are invisible until the user starts scrolling. */
  .items-list::-webkit-scrollbar { width: 6px; -webkit-appearance: none; }
  .items-list::-webkit-scrollbar-track { background: transparent; }
  .items-list::-webkit-scrollbar-thumb {
    background: rgba(240,240,240,.2);
    border-radius: 3px;
  }
  .items-list::-webkit-scrollbar-thumb:hover {
    background: rgba(240,240,240,.4);
  }

  /* ── Einzelnes Ergebnis ── */
  .item {
    display: flex; align-items: center; gap: 10px;
    padding: 5px 6px; border-radius: 8px; cursor: pointer;
    transition: background 0.1s;
  }
  .item:hover { background: rgba(255,255,255,.06); }
  .item.played { background: rgba(252,60,68,.15); transition: background 0s; }

  /* ── Thumbnail ── */
  .thumb-wrap {
    position: relative; width: 42px; height: 42px; flex-shrink: 0;
    border-radius: 6px; overflow: hidden;
    background: rgba(255,255,255,.07);
  }
  .thumb {
    position: absolute; inset: 0;
    width: 100%; height: 100%; object-fit: cover; display: block;
  }
  .thumb-ph {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .thumb-ph.hidden { display: none; }
  .thumb-ph ha-icon { --mdc-icon-size: 20px; color: rgba(240,240,240,.35); }

  /* ── Info-Bereich ── */
  .item-info {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column; gap: 2px;
  }
  .item-title {
    font-size: 0.88em; font-weight: 500;
    color: #f0f0f0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .item-sub {
    font-size: 0.74em; color: rgba(240,240,240,.55);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* ── Aktions-Buttons ── */
  .item-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .action-btn {
    background: none; border: none; padding: 4px; cursor: pointer;
    color: rgba(240,240,240,.7);
    display: flex; align-items: center;
    border-radius: 50%; opacity: 0;
    transition: opacity 0.12s, color 0.12s, background 0.12s;
  }
  .item:hover .action-btn { opacity: 1; }
  /* Expand chevron always visible — signals drilldown on touch devices too */
  .expand-btn { opacity: 0.5; }
  .item:hover .expand-btn { opacity: 1; }
  .play-btn:hover { color: #fc3c44; }
  .expand-btn:hover { color: #ffffff; }
  .action-btn ha-icon { --mdc-icon-size: 22px; }

  /* ── Status / Lade / Leer ── */
  .status-bar {
    padding: 6px 16px 10px;
    font-size: 0.82em; text-align: center;
    min-height: 14px; color: rgba(240,240,240,.45);
  }
  .loading, .empty {
    display: flex; align-items: center; justify-content: center;
    gap: 8px; padding: 24px 16px;
    color: rgba(240,240,240,.45); font-size: 0.88em;
  }
  .loading ha-icon, .empty ha-icon { --mdc-icon-size: 20px; }
  .spin { animation: spin 0.85s linear infinite; display: inline-flex; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .truncation-hint {
    padding: 6px 14px 10px;
    font-size: 0.75em;
    color: var(--secondary-text-color);
    text-align: center;
    font-style: italic;
  }
`;

// ── Editor-Element für den visuellen Konfigurationsdialog ────────────────────
// Nutzt HA's eingebautes <ha-form>-Element mit einem Schema für entity + title.
// Feuert 'config-changed' wenn der Nutzer Werte ändert – HA speichert das
// automatisch. Durch getConfigElement() auf der Hauptkarte erscheinen die
// drei Standard-Tabs: Konfiguration | Sichtbarkeit | Layout.

class AmSearchCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass   = null;
    this._form   = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  setConfig(config) {
    this._config = { ...config };
    if (!this._form) {
      const form        = document.createElement('ha-form');
      form.schema       = [
        { name: 'entity', required: true, selector: { entity: { domain: 'media_player' } } },
        { name: 'title',  selector: { text: {} } },
      ];
      form.computeLabel = (s) =>
        ({ entity: 'Media Player', title: 'Titel (optional)' })[s.name] ?? s.name;
      form.addEventListener('value-changed', (ev) => {
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent('config-changed', {
          detail:   { config: this._config },
          bubbles:  true,
          composed: true,
        }));
      });
      if (this._hass) form.hass = this._hass;
      this._form = form;
      this.appendChild(form);
    }
    this._form.data = this._config;
  }
}

customElements.define('am-search-card-editor', AmSearchCardEditor);

// ── Registrierung ─────────────────────────────────────────────────────────────

customElements.define('am-search-card', AmSearchCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type:        'am-search-card',
  name:        'Apple Music Search',
  description: 'Suche und Wiedergabe für die Apple Music Custom Integration',
  preview:     false,
});
