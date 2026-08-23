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
  { id: 'genre',    label: 'Genre',     classes: ['genre'] },
  { id: 'playlist', label: 'Playlist',  classes: ['playlist'] },
];

const MEDIA_ICONS = {
  track:    'mdi:music-note',
  album:    'mdi:album',
  artist:   'mdi:account-music',
  playlist: 'mdi:playlist-music',
  genre:    'mdi:tag-multiple',
};

const MEDIA_LABELS = {
  track: 'Track', album: 'Album', artist: 'Künstler', playlist: 'Playlist',
  genre: 'Genre',
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
    this._includeVideos  = false;  // Frontend-Haken 'Musikvideos inkludieren'
    this._lastPlayHadVideo = false; // unterdrueckt always_off bei Videos
    this._progressTimer  = null;  // setInterval für live Fortschrittsanzeige
    this._amListSignature = null; // erkennt Änderungen der AirPlay-Player-Liste

    this._seekOverride   = null;  // sofortiges visuelles Feedback nach Seek
    this._playingContext = null;  // track | album | artist | playlist
    // Navigation-Stack: jeder Eintrag = { title, items, isSearch? }
    this._navStack    = [];
  }

  // ── Lovelace lifecycle ──────────────────────────────────────────────────────

  setConfig(config) {
    if (!config.entity) throw new Error('am-search-card: "entity" ist erforderlich');
    // Musikvideos sind standardmaessig nicht erlaubt
    this._config = { title: 'Apple Music', allow_music_videos: false, volume_control: 'slider', onscreen_keyboard: false, ...config };
    this._build();
    // Haken folgt der Konfiguration: erlaubt -> gesetzt, sonst ausgeblendet.
    // Muss hier stehen, da _build() nur einmal laeuft.
    this._includeVideos = !!this._config.allow_music_videos;
    const toggle = this.shadowRoot?.querySelector('.video-toggle');
    if (toggle) toggle.style.display = this._includeVideos ? '' : 'none';
    const videoBox = this.shadowRoot?.querySelector('.include-videos-cb');
    if (videoBox) videoBox.checked = this._includeVideos;
    // Lautstaerke: Regler oder Schritt-Tasten
    // Bei eigener Tastatur die System-Tastatur unterdruecken
    const searchInput = this.shadowRoot?.querySelector('.search-input');
    if (searchInput) {
      if (this._config.onscreen_keyboard) searchInput.setAttribute('inputmode', 'none');
      else searchInput.removeAttribute('inputmode');
    }
    if (!this._config.onscreen_keyboard) this._showKeyboard(false);

    const useSteps = this._config.volume_control === 'buttons';
    const sldr  = this.shadowRoot?.querySelector('.np-vol-slider');
    const steps = this.shadowRoot?.querySelector('.np-vol-steps');
    if (sldr)  sldr.style.display  = useSteps ? 'none' : '';
    if (steps) steps.style.display = useSteps ? '' : 'none';
    // always_off sofort durchsetzen wenn Config sich ändert
    if (this._hass) this._enforceAlwaysOff();
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!this._built) return;
    const id = this._config?.entity;
    if (!id) return;
    const ns = hass?.states?.[id];
    const os = prev?.states?.[id];
    // AirPlay-Panel aktualisieren
    this._populateAMPlayers();
    // always_off kontinuierlich durchsetzen wenn Player spielt
    if (ns?.state === 'playing' && ns?.state !== os?.state) {
      this._enforceAlwaysOff();
    }

    if (ns?.state !== os?.state ||
        ns?.attributes?.media_title !== os?.attributes?.media_title ||
        ns?.attributes?.entity_picture !== os?.attributes?.entity_picture ||
        ns?.attributes?.volume_level !== os?.attributes?.volume_level ||
        ns?.attributes?.is_volume_muted !== os?.attributes?.is_volume_muted ||
        ns?.attributes?.media_duration !== os?.attributes?.media_duration ||
        ns?.attributes?.shuffle !== os?.attributes?.shuffle ||
        ns?.attributes?.media_playlist !== os?.attributes?.media_playlist ||
        ns?.attributes?.repeat !== os?.attributes?.repeat) {
      this._renderNowPlaying();
    }

    if (ns?.attributes?.media_content_id !== os?.attributes?.media_content_id) {
      this._updateNowMarker();
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

  // Erkennt die AM-Haupt-Entity automatisch:
  // Alle apple_music-Entities → Entity mit höchsten supported_features = Controller
  // (Haupt-Player: ~4641343, AirPlay-Sub-Entities: 388)
  static getStubConfig(hass) {
    const amEntities = Object.values(hass?.entities || {})
      .filter(e => e.platform === 'apple_music' && e.entity_id.startsWith('media_player.'));
    let mainEntity = null;
    let maxFeatures = -1;
    for (const e of amEntities) {
      const features = hass.states?.[e.entity_id]?.attributes?.supported_features || 0;
      if (features > maxFeatures) { maxFeatures = features; mainEntity = e; }
    }
    // Fallback: erste gefundene AM-Entity oder Standardname
    const entityId = mainEntity?.entity_id
      || amEntities[0]?.entity_id
      || 'media_player.am_apple_music';
    return { entity: entityId, title: 'Apple Music' };
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
      // Gleiche Logik wie beim Leeren per Tastatur: bei aktivem Playlist-Filter
      // die vollstaendige Playlist-Liste zeigen statt eine leere Ansicht.
      if (!this._loadAllForFilter()) {
        this._navStack = [];
        this._renderView();
      }
      input.focus();
    });

    input.addEventListener('input', () => {
      updateClearBtn();
      clearTimeout(this._debounce);
      const q = input.value.trim();
      if (!q) {
        if (!this._loadAllForFilter()) {
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

    // Bildschirmtastatur oeffnen, sobald das Suchfeld angetippt wird
    input.addEventListener('focus', () => {
      if (this._config.onscreen_keyboard) this._showKeyboard(true);
    });

    // Kontext-Label: laufende Wiedergabeliste anzeigen
    s.querySelector('.np-context').addEventListener('click', () => {
      const pl  = this._hass?.states?.[this._config.entity]?.attributes?.media_playlist;
      const key = this._contextFromPlaylist(pl) || this._playingContext;
      if (key && key !== 'track') { this._loadNowPlayingList(); }
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
        } else if (!this._loadAllForFilter()) {
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

    // Lautstaerke in Schritten – Alternative zum Regler, besser am Tablet treffbar
    const stepVolume = (delta) => {
      if (!this._hass) return;
      const st  = this._hass.states?.[this._config.entity];
      const cur = st?.attributes?.volume_level ?? 0.5;
      const next = Math.min(1, Math.max(0, Math.round((cur + delta) * 100) / 100));
      this._hass.callService('media_player', 'volume_set', {
        entity_id: this._config.entity,
        volume_level: next,
      });
    };
    s.querySelector('.np-vol-down').addEventListener('click', () => stepVolume(-0.05));
    s.querySelector('.np-vol-up').addEventListener('click',   () => stepVolume(0.05));

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

    // Gesamte Kopfflaeche schaltet das Panel um. Safari reagiert bei <summary>
    // sonst nur auf den Textinhalt, nicht auf Rahmen und Innenabstand.
    const amBtn = s.querySelector('.am-player-btn');
    amBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const panel = s.querySelector('.am-player-panel');
      if (panel) panel.open = !panel.open;
    });

    // AirPlay Panel: Klick außerhalb schließt
    document.addEventListener('click', (e) => {
      const panel = this.shadowRoot?.querySelector('.am-player-panel');
      if (panel?.open) {
        const path = e.composedPath();
        if (!path.includes(panel)) panel.open = false;
      }
    });

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

  // ── AirPlay Player Panel ─────────────────────────────────────────────────────
  _populateAMPlayers() {
    const panel = this.shadowRoot?.querySelector('.am-player-panel');
    const list  = this.shadowRoot?.querySelector('.am-player-list');
    const btn   = this.shadowRoot?.querySelector('.am-player-btn');
    if (!panel || !this._hass) return;
    const base      = this._config.entity;
    const playerCfg = this._config.players || {};

    const platform = this._hass.entities?.[base]?.platform;
    const players = platform
      ? Object.values(this._hass.entities)
          .filter(e => e.platform === platform && e.entity_id !== base && e.entity_id.startsWith('media_player.'))
          .map(e => e.entity_id).sort()
      : [];

    const displayName = (e) => {
      const cfg = playerCfg[e] || {};
      if (cfg.name) return cfg.name;
      return this._hass.states[e]?.attributes?.friendly_name || e;
    };
    // isOn: state !== 'off' = via HA aktiv
    const isOn = (e) => {
      const st = this._hass.states[e]?.state;
      return !!st && st !== 'off' && st !== 'unavailable' && st !== 'unknown';
    };

    const available = players.filter(e => {
      const cfg = playerCfg[e] || {};
      if (cfg.hidden || cfg.always_off) return false;
      const st = this._hass.states[e]?.state;
      return st && st !== 'unavailable' && st !== 'unknown';
    });
    if (available.length === 0) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');

    // Button-Label – direkt aus aktuellem State, kein Cache
    const activeAll = players.filter(e => !(playerCfg[e]?.always_off) && isOn(e));
    let label;
    if (activeAll.length === 1) label = displayName(activeAll[0]);
    else if (activeAll.length > 1) label = `AirPlay (${activeAll.length})`;
    else label = '---';
    btn.textContent = `🔊 ${label}`;
    btn.classList.toggle('active', activeAll.length > 0);

    // Liste NUR neu bauen wenn sich die Player-Zusammensetzung ändert.
    // Ein innerHTML-Rebuild bei jedem hass-Update würde die Checkbox zwischen
    // Klick und change-Event zerstören – der Klick ginge verloren (passiert
    // während der Wiedergabe, weil dann laufend Positions-Updates kommen).
    const signature = available.map(e => e + '|' + displayName(e)).join(',');
    if (signature !== this._amListSignature) {
      this._amListSignature = signature;
      list.innerHTML = available.map(e => `<label class="am-player-item" title="${displayName(e)}">
        <input type="checkbox" data-entity="${e}"/>
        <span style="overflow:hidden;text-overflow:ellipsis">${displayName(e)}</span>
      </label>`).join('');

      list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', (ev) => {
          ev.stopPropagation();
          const entity = cb.dataset.entity;
          this._hass.callService('media_player', cb.checked ? 'turn_on' : 'turn_off',
            { entity_id: entity });
          // Zusaetzlich hinterlegtes Skript ausloesen (z. B. Verstaerker einschalten)
          const cfg = (this._config.players || {})[entity] || {};
          this._runPlayerScript(cb.checked ? cfg.script_on : cfg.script_off);
        });
      });
    }

    // Checked-Zustand in-place aktualisieren – DOM bleibt erhalten.
    // Gerade angeklickte Checkbox nicht überschreiben (sonst springt sie zurück,
    // bevor HA den neuen State gemeldet hat).
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb === this.shadowRoot.activeElement) return;
      const desired = isOn(cb.dataset.entity);
      if (cb.checked !== desired) cb.checked = desired;
    });
  }

  // ── Immer-Aus-Enforcement ────────────────────────────────────────────────────
  _enforceAlwaysOff() {
    const playerCfg = this._config.players || {};
    const alwaysOff = Object.entries(playerCfg)
      .filter(([, cfg]) => cfg.always_off).map(([entity]) => entity);
    if (!alwaysOff.length) return;

    // Lautstaerke auf 0 – wirkt auch dann, wenn Music.app das Geraet fuer ein
    // Musikvideo zwingend als Ziel waehlt und ein turn_off wirkungslos bliebe.
    alwaysOff.forEach(entity =>
      this._hass?.callService('media_player', 'volume_set',
        { entity_id: entity, volume_level: 0 })
    );

    // Bei Musikvideos kein turn_off: Music.app waehlt das Geraet sofort erneut
    // aus, das ergaebe nur ein An/Aus-Pendeln.
    if (this._lastPlayHadVideo) return;
    // Immer turn_off senden – kein State-Check nötig
    // (AirPlay-State in HA ist oft 'off' auch wenn Gerät noch Audio empfängt)
    const turnOff = () => alwaysOff.forEach(entity =>
      this._hass?.callService('media_player', 'turn_off', { entity_id: entity })
    );
    turnOff();
    setTimeout(turnOff, 2000);
  }

  // ── Aktive Player nach Play nochmals einschalten ────────────────────────────
  // Snapshot VOR dem Play – damit wir wissen welche Player gerade aktiv waren
  _getActivePlayers() {
    const playerCfg = this._config.players || {};
    const base      = this._config.entity;
    const platform  = this._hass?.entities?.[base]?.platform;
    if (!platform) return [];
    return Object.values(this._hass.entities || {})
      .filter(e => e.platform === platform &&
                   e.entity_id !== base &&
                   e.entity_id.startsWith('media_player.'))
      .map(e => e.entity_id)
      .filter(entity => {
        const cfg = playerCfg[entity] || {};
        if (cfg.always_off || cfg.hidden) return false;
        const st = this._hass?.states?.[entity]?.state;
        return !!st && st !== 'off' && st !== 'unavailable' && st !== 'unknown';
      });
  }

  // Aktive Player nochmals einschalten falls sie nach dem Play nicht spielen
  // Nur turn_on wenn State nicht aktiv – verhindert unnötige AirPlay-Reconnects
  _enforceActivePlayers(active) {
    if (!active?.length) return;

    // Erster Durchgang ohne Pruefung: nach laengerer Pause meldet HA die Player
    // weiterhin als 'on', obwohl die AirPlay-Verbindung eingeschlafen ist. Ein
    // turn_on stellt sie wieder her; eine Zustandspruefung wuerde es verhindern.
    setTimeout(() => active.forEach(entity =>
      this._hass?.callService('media_player', 'turn_on', { entity_id: entity })
    ), 1200);

    // Zweiter Durchgang als Absicherung, nur fuer weiterhin inaktive Player
    setTimeout(() => active.forEach(entity => {
      const st = this._hass?.states?.[entity]?.state;
      const isActive = !!st && st !== 'off' && st !== 'unavailable' && st !== 'unknown';
      if (!isActive) {
        this._hass?.callService('media_player', 'turn_on', { entity_id: entity });
      }
    }), 2800);
  }

  // ── Bildschirmtastatur ──────────────────────────────────────────────────────
  // Fuer Tablets, auf denen die System-Tastatur nicht erscheint (z. B. Kiosk-
  // Browser). Schreibt in das Suchfeld und loest dort ein input-Event aus,
  // damit die vorhandene Suchlogik unveraendert greift.
  _buildKeyboard() {
    const box = this.shadowRoot?.querySelector('.kbd');
    if (!box || box.dataset.built) return;
    box.dataset.built = '1';

    const rows = [
      ['1','2','3','4','5','6','7','8','9','0'],
      ['q','w','e','r','t','z','u','i','o','p','ü'],
      ['a','s','d','f','g','h','j','k','l','ö','ä'],
      ['y','x','c','v','b','n','m','ß','-'],
    ];

    const input = this.shadowRoot.querySelector('.search-input');
    const fire  = () => input.dispatchEvent(new Event('input', { bubbles: true }));

    const makeKey = (label, cls, onTap) => {
      const b = document.createElement('button');
      b.className = 'kbd-key' + (cls ? ' ' + cls : '');
      b.textContent = label;
      // mousedown abfangen, damit das Suchfeld den Fokus behaelt
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.preventDefault(); onTap(); });
      return b;
    };

    rows.forEach(keys => {
      const row = document.createElement('div');
      row.className = 'kbd-row';
      keys.forEach(k => row.appendChild(
        makeKey(k, '', () => { input.value += k; fire(); })
      ));
      box.appendChild(row);
    });

    const last = document.createElement('div');
    last.className = 'kbd-row';
    last.appendChild(makeKey('Leerzeichen', 'wide', () => { input.value += ' '; fire(); }));
    last.appendChild(makeKey('\u232B', '', () => {
      input.value = input.value.slice(0, -1); fire();
    }));
    last.appendChild(makeKey('Fertig', 'done', () => this._showKeyboard(false)));
    box.appendChild(last);
  }

  _showKeyboard(show) {
    const box = this.shadowRoot?.querySelector('.kbd');
    if (!box) return;
    if (show) this._buildKeyboard();
    box.classList.toggle('hidden', !show);
  }

  // ── Musikvideo-Filter ────────────────────────────────────────────────────────
  // mediaKind ist Teil der content_id: track||id||artist||album||mediaKind (5. Teil)
  // Videos erscheinen nur wenn die Karte sie erlaubt UND der Haken gesetzt ist.
  get _videosVisible() {
    return !!this._config?.allow_music_videos && this._includeVideos;
  }

  _filterVideos(items) {
    if (this._videosVisible) return items;
    return items.filter(i => {
      const cid   = i.media_content_id || '';
      const parts = cid.split('||');
      if (parts[0] === 'track')    return parts[4] !== 'music video'; // track||id||artist||album||mediaKind
      if (parts[0] === 'album')    return parts[3] !== 'music video'; // album||artist||name||mediaKind
      if (parts[0] === 'playlist') return parts[2] !== 'music video'; // playlist||id||mediaKind
      if (parts[0] === 'artist')   return parts[2] !== 'music video'; // artist||name||mediaKind
      if (parts[0] === 'genre')    return parts[2] !== 'music video'; // genre||name||mediaKind
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
    // entity_picture_local = HA-proxy URL (relativ, immer erreichbar auch auf HTTPS)
    const pic = a.entity_picture_local
      ? (a.entity_picture_local.startsWith('/') ? location.origin + a.entity_picture_local : a.entity_picture_local)
      : a.entity_picture || '';
    if (pic) { cover.src = pic; cover.style.display = 'block'; }
    else { cover.style.display = 'none'; }
    s.querySelector('.np-title').textContent  = a.media_title  || '';
    s.querySelector('.np-artist').textContent = a.media_artist || '';
    const ctxEl  = s.querySelector('.np-context');
    const ctxMap = { track: 'Track', album: 'Album', artist: 'Künstler',
                     genre: 'Genre', playlist: 'Playlist', search_results: 'Suche' };
    // Kontext aus dem Namen der laufenden Wiedergabeliste ableiten. Damit stimmt
    // das Label auf jedem Geraet – auch dort, wo die Wiedergabe nicht gestartet
    // wurde. _playingContext dient nur noch als Rueckfall.
    const ctxKey = this._contextFromPlaylist(a.media_playlist) || this._playingContext;
    const ctxTxt = ctxMap[ctxKey] || '';
    if (ctxEl) {
      ctxEl.querySelector('.np-context-text').textContent = ctxTxt;
      ctxEl.classList.toggle('hidden', !ctxTxt);
      // Bei einem einzelnen Track waere die Liste nur einen Titel lang –
      // dann bleibt das Label reine Beschriftung.
      const tappable = !!ctxTxt && ctxKey !== 'track';
      ctxEl.classList.toggle('tappable', tappable);
      ctxEl.querySelector('ha-icon').style.display = tappable ? '' : 'none';
      ctxEl.disabled = !tappable;
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
    const vVal = s.querySelector('.np-vol-value');
    if (vVal) vVal.textContent = `${vol}%`;
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

  // Zeigt bei leerem Suchfeld die vollstaendige Liste – fuer Playlists und Genres
  _loadAllForFilter() {
    if (this._filter === 'playlist') { this._loadAllPlaylists(); return true; }
    if (this._filter === 'genre')    { this._loadAllGenres();    return true; }
    return false;
  }

  // Startet ein in der Konfiguration hinterlegtes Skript.
  _runPlayerScript(entityId) {
    if (!entityId || !this._hass) return;
    this._hass.callService('script', 'turn_on', { entity_id: entityId });
  }

  // Ordnet den Namen der laufenden Wiedergabeliste einem Kontext zu.
  // Die HA_Play_*-Hilfslisten legt der Server je nach Startart an;
  // jeder andere Name ist eine echte Playlist aus Music.app.
  _contextFromPlaylist(name) {
    if (!name) return null;
    if (name.startsWith('HA_Play_Search')) return 'search_results';
    if (name === 'HA_Play_Album')  return 'album';
    if (name === 'HA_Play_Artist') return 'artist';
    if (name === 'HA_Play_Genre')  return 'genre';
    if (name === 'HA_Play_Track')  return 'track';
    return 'playlist';
  }

  // Markierung des laufenden Titels nachziehen, ohne die Liste neu zu bauen –
  // ein Neuaufbau wuerde die Scrollposition verwerfen.
  _updateNowMarker() {
    const list = this.shadowRoot?.querySelector('.items-list');
    if (!list) return;
    const playingId = this._hass?.states?.[this._config.entity]?.attributes?.media_content_id || '';
    list.querySelectorAll('.item').forEach(el => {
      const id = el.dataset.track || '';
      el.classList.toggle('item-now', !!id && id === playingId);
    });
  }

  // Titel der gerade laufenden Wiedergabeliste als Trefferliste zeigen.
  // Wird bei jedem Aufruf frisch geholt – zeigt damit den echten Stand,
  // nicht einen gemerkten Suchvorgang.
  async _loadNowPlayingList() {
    this._loading = true;
    this._error   = '';
    this._renderLoading();
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type:               'media_player/browse_media',
        entity_id:          this._config.entity,
        media_content_type: 'playlist',
        media_content_id:   'now_playing',
      });
      const items = res?.children ?? [];
      const title = items.length
        ? `Läuft gerade · ${items.length} Titel`
        : 'Läuft gerade';
      this._navStack = [{ title, items }];
      this._renderView();
    } catch (e) {
      this._error = 'Wiedergabeliste konnte nicht geladen werden: ' + (e?.message ?? e);
      this._renderError();
    } finally {
      this._loading = false;
    }
  }

  async _loadAllGenres() {
    this._loading = true;
    this._error   = '';
    this._renderLoading();
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type:               'media_player/browse_media',
        entity_id:          this._config.entity,
        media_content_type: 'genre',
        media_content_id:   'genres',
      });
      const items = res?.children ?? [];
      this._navStack = [{ title: 'Genres', items }];
      this._renderView();
    } catch (e) {
      this._error = 'Genres konnten nicht geladen werden: ' + (e?.message ?? e);
      this._renderError();
    } finally {
      this._loading = false;
    }
  }

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
      if (this._videosVisible) return false;
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
      String(i.media_content_id).startsWith('album||') ||
      String(i.media_content_id).startsWith('genre||')
    );

    if (expandable.length > 0) {
      this._renderLoading();
      for (const item of expandable) {
        try {
          const res = await browse(item);
          const children = res?.children ?? [];
          // Genre und Album liefern direkt Tracks, nur Artist braucht zwei Ebenen
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
      const activeBefore = this._getActivePlayers();
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
      // Bei gemischten Listen ist nicht bekannt, wann ein Video an der Reihe
      // ist – always_off greift hier wie bisher.
      this._lastPlayHadVideo = false;
      this._enforceAlwaysOff();
      this._enforceActivePlayers(activeBefore);
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
    // mediaKind steckt je nach Typ an unterschiedlicher Position der content_id
    const p = (item.media_content_id || '').split('||');
    const kind = p[0] === 'track' ? p[4] : p[0] === 'album' ? p[3] : p[2];
    this._lastPlayHadVideo = (kind === 'music video');
    const activeBefore = this._getActivePlayers();
    this._hass.callService('media_player', 'play_media', {
      entity_id:          this._config.entity,
      media_content_type: item.media_content_type,
      media_content_id:   item.media_content_id,
    });
    this._enforceAlwaysOff();
    this._enforceActivePlayers(activeBefore);
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

    // persistentID des laufenden Titels – markiert die Zeile in der laufenden Liste
    const playingId = this._hass?.states?.[this._config.entity]?.attributes?.media_content_id || '';

    list.innerHTML = items.map((item, idx) => {
      const icon     = MEDIA_ICONS[item.media_class] || 'mdi:music';
      const cidParts = String(item.media_content_id || '').split('||');
      const isNow    = !!playingId && cidParts[0] === 'track' && cidParts[1] === playingId;
      const subLabel = item.title.includes(' — ')
        ? item.title.split(' — ').slice(1).join(' — ')
        : (MEDIA_LABELS[item.media_class] || item.media_class);
      const mainTitle = item.title.includes(' — ')
        ? item.title.split(' — ')[0]
        : item.title;

      return `
        <div class="item${isNow ? ' item-now' : ''}" data-idx="${idx}" data-track="${cidParts[0] === 'track' ? this._esc(cidParts[1] || '') : ''}">
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
          <button class="np-context hidden" title="Laufende Wiedergabeliste anzeigen">
            <ha-icon icon="mdi:playlist-music"></ha-icon><span class="np-context-text"></span>
          </button>
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
          <div class="np-vol-steps">
            <button class="np-vol-down" title="Leiser"><ha-icon icon="mdi:minus"></ha-icon></button>
            <span class="np-vol-value">50%</span>
            <button class="np-vol-up" title="Lauter"><ha-icon icon="mdi:plus"></ha-icon></button>
          </div>
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
    <details class="am-player-panel hidden">
      <summary class="am-player-btn">🔊 ---</summary>
      <div class="am-player-list"></div>
    </details>
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
    <div class="kbd hidden"></div>
    <div class="video-toggle">
      <label class="video-toggle-label">
        <input type="checkbox" class="include-videos-cb" />
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
    height: 100%; overflow: hidden; position: relative;
    background: #0d0d0d !important;
    color: #f0f0f0;
  }

  .am-player-panel {
    position: relative; margin-left: auto; margin-right: 8px; align-self: center; line-height: 1;
  }
  .am-player-panel.hidden { display: none; }
  .am-player-btn {
    cursor: pointer; list-style: none;
    background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14);
    color: rgba(240,240,240,.5); border-radius: 4px; font-size: 0.6em;
    padding: 0px 4px; white-space: nowrap; user-select: none;
    display: block; width: fit-content; max-width: 240px;
    overflow: hidden; text-overflow: ellipsis; line-height: 1.4;
  }
  .am-player-btn::-webkit-details-marker { display: none; }
  .am-player-btn.active { border-color: rgba(240,240,240,.5); color: rgba(240,240,240,.85); }
  .am-player-list {
    position: absolute; right: 0; top: calc(100% + 4px);
    background: #222; border: 1px solid rgba(255,255,255,.2);
    border-radius: 8px; padding: 4px; z-index: 200;
    min-width: 200px; width: max-content; max-width: 280px;
    max-height: 220px; overflow-y: auto;
  }
  .am-player-item {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 8px; cursor: pointer; border-radius: 5px;
    font-size: 0.75em; color: rgba(240,240,240,.8);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .am-player-item:hover { background: rgba(255,255,255,.08); }
  .am-player-item input[type="checkbox"] {
    accent-color: #fc3c44; cursor: pointer; width: 16px; height: 16px; flex-shrink: 0;
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
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 0.62em;
    color: rgba(240,240,240,.38);
    letter-spacing: 0.04em;
    font-weight: 500;
    background: none; border: none; padding: 0;
    font-family: inherit; text-align: left;
  }
  .np-context ha-icon { --mdc-icon-size: 13px; }
  .item-now .item-title { color: #fc3c44; }
  .np-context.tappable {
    border: 1px solid rgba(255,255,255,.18); border-radius: 999px;
    padding: 1px 8px; cursor: pointer; color: rgba(240,240,240,.6);
  }
  .np-context.tappable:hover { color: #ffffff; border-color: rgba(255,255,255,.4); }
  .np-vol-btn {
    background: none; border: none; cursor: pointer;
    color: rgba(240,240,240,.55); display: flex; align-items: center;
    padding: 3px; border-radius: 50%; flex-shrink: 0;
    transition: color 0.15s;
  }
  .np-vol-btn:hover { color: #ffffff; }
  .np-vol-steps { display: flex; align-items: center; gap: 4px; }
  .np-vol-steps button {
    background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.18);
    color: rgba(240,240,240,.8); border-radius: 8px; cursor: pointer;
    width: 34px; height: 30px; display: flex; align-items: center; justify-content: center;
    padding: 0; --mdc-icon-size: 18px;
  }
  .np-vol-steps button:hover { background: rgba(255,255,255,.16); color: #ffffff; }
  .np-vol-steps button:active { transform: scale(.94); }
  .np-vol-value {
    min-width: 42px; text-align: center; font-size: 0.8em; color: rgba(240,240,240,.7);
  }
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
  .search-area { padding: 0 12px 8px; touch-action: pan-x pinch-zoom; }
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
  /* Im normalen Fluss, damit die Karte bei rows: auto mitwaechst und die
     Tastatur bei fester Hoehe die Liste zusammenschiebt statt sie zu verdecken */
  .kbd {
    flex: 0 0 auto; margin: 6px 0;
    background: #1b1b1b; border: 1px solid rgba(255,255,255,.12); border-radius: 8px;
    padding: 5px; display: flex; flex-direction: column; gap: 4px;
  }
  .kbd.hidden { display: none; }
  .kbd-row { display: flex; gap: 4px; justify-content: center; }
  .kbd-key {
    flex: 1 1 0; min-width: 0; height: 40px;
    background: rgba(255,255,255,.10); border: none; border-radius: 6px;
    color: #f0f0f0; font-size: 0.95em; cursor: pointer; padding: 0;
    display: flex; align-items: center; justify-content: center;
    -webkit-tap-highlight-color: transparent;
  }
  .kbd-key:active { background: rgba(255,255,255,.28); }
  .kbd-key.wide  { flex: 3 1 0; }
  .kbd-key.done  { flex: 2 1 0; background: #fc3c44; color: #4A1B0C; }
  .items-list {
    flex: 1; min-height: 80px; max-height: 440px; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
    overscroll-behavior: contain;
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
    this._playerSection = null;
    this._sectionFocused = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    this._renderPlayers();
  }

  setConfig(config) {
    this._config = { ...config, players: { ...(config.players || {}) } };
    if (!this._form) {
      const form        = document.createElement('ha-form');
      form.schema       = [
        { name: 'title', selector: { text: {} } },
        { name: 'allow_music_videos', selector: { boolean: {} } },
        { name: 'onscreen_keyboard', selector: { boolean: {} } },
        { name: 'volume_control', selector: { select: { mode: 'dropdown', options: [
          { value: 'slider',  label: 'Schieberegler' },
          { value: 'buttons', label: 'Plus / Minus (Tablet)' },
        ] } } },
      ];
      form.computeLabel = (s) => ({
        title: 'Titel (optional)',
        allow_music_videos: 'Musikvideos erlauben',
        onscreen_keyboard: 'Bildschirmtastatur (Tablet)',
        volume_control: 'Lautstärkeregelung',
      })[s.name] ?? s.name;
      form.addEventListener('value-changed', (ev) => {
        this._config = {
          ...this._config,
          title: ev.detail.value.title,
          allow_music_videos: !!ev.detail.value.allow_music_videos,
          onscreen_keyboard: !!ev.detail.value.onscreen_keyboard,
          volume_control: ev.detail.value.volume_control || 'slider',
        };
        this._dispatch();
      });
      if (this._hass) form.hass = this._hass;
      this._form = form;
      this.appendChild(form);

      const sec = document.createElement('div');
      sec.style.cssText = 'margin-top:16px;';
      sec.innerHTML = '<div style="font-size:0.85em;font-weight:500;color:var(--secondary-text-color);margin-bottom:8px;padding:0 4px">AirPlay Empfänger</div>';
      this._playerSection = document.createElement('div');
      this._playerSection.addEventListener('focusin',  () => { this._sectionFocused = true;  });
      this._playerSection.addEventListener('focusout', () => { this._sectionFocused = false; });
      sec.appendChild(this._playerSection);
      this.appendChild(sec);
    }
    this._form.data = {
      title: this._config.title,
      allow_music_videos: !!this._config.allow_music_videos,
      onscreen_keyboard: !!this._config.onscreen_keyboard,
      volume_control: this._config.volume_control || 'slider',
    };
    this._renderPlayers();
  }

  _getAMPlayers() {
    if (!this._hass) return [];
    const base = this._config.entity;
    return Object.values(this._hass.entities || {})
      .filter(e => e.platform === 'apple_music' && e.entity_id !== base && e.entity_id.startsWith('media_player.'))
      .map(e => e.entity_id).sort();
  }

  _renderPlayers() {
    if (!this._playerSection || !this._hass) return;
    // Kein Neuaufbau solange in der Sektion etwas bearbeitet wird. Bei den
    // Auswahlfeldern liegt der Fokus im eigenen Schattenbaum – eine Suche nach
    // ':focus' wuerde ihn nicht finden, daher der mitgefuehrte Merker.
    if (this._sectionFocused) return;
    const players   = this._getAMPlayers();
    if (players.length === 0) { this._playerSection.innerHTML = ''; return; }
    const playerCfg = this._config.players || {};
    this._playerSection.innerHTML = players.map(e => {
      const defaultName = this._hass.states[e]?.attributes?.friendly_name || e;
      const cfg         = playerCfg[e] || {};
      const stateColor  = (this._hass.states[e]?.state === 'unavailable') ? '#888' : '#4caf50';
      return `<div style="padding:6px 4px;border-bottom:1px solid var(--divider-color)" data-entity="${e}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="width:8px;height:8px;border-radius:50%;background:${stateColor};flex-shrink:0"></span>
          <span style="font-size:0.8em;flex:0 0 110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--primary-text-color)" title="${defaultName}">${defaultName}</span>
          <input type="text" class="player-name" data-entity="${e}"
                 placeholder="Benutzerdefinierter Name" value="${cfg.name || ''}"
                 style="flex:1;font-size:0.78em;background:var(--card-background-color);
                        border:1px solid var(--divider-color);border-radius:4px;
                        padding:3px 6px;color:var(--primary-text-color)"/>
        </div>
        <div style="display:flex;gap:20px;padding-left:18px;margin-top:2px;border-left:2px solid var(--divider-color)">
          <label style="display:flex;align-items:center;gap:5px;font-size:0.73em;color:var(--secondary-text-color);cursor:pointer">
            <input type="checkbox" class="player-hidden" data-entity="${e}" ${cfg.hidden ? 'checked' : ''}
                   style="cursor:pointer;width:14px;height:14px"/>
            Nie anzeigen
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:0.73em;color:var(--secondary-text-color);cursor:pointer">
            <input type="checkbox" class="player-always-off" data-entity="${e}" ${cfg.always_off ? 'checked' : ''}
                   style="cursor:pointer;width:14px;height:14px"/>
            Immer Aus
          </label>
        </div>
        <div style="display:flex;gap:8px;padding-left:18px;margin-top:6px;
                    border-left:2px solid var(--divider-color)">
          <ha-selector class="player-script-on"  data-entity="${e}" style="flex:1;min-width:0"></ha-selector>
          <ha-selector class="player-script-off" data-entity="${e}" style="flex:1;min-width:0"></ha-selector>
        </div>
      </div>`;
    }).join('');

    this._playerSection.querySelectorAll('.player-name').forEach(inp => {
      inp.addEventListener('input', () => {
        const e = inp.dataset.entity;
        this._config.players = { ...this._config.players, [e]: { ...(this._config.players[e]||{}), name: inp.value.trim() } };
        this._dispatch();
      });
    });
    // Standard-Auswahlfeld von Home Assistant, auf Skripte und Szenen begrenzt
    const scriptSelector = { entity: { domain: 'script' } };
    [['player-script-on', 'script_on', 'Skript beim Einschalten'],
     ['player-script-off', 'script_off', 'Skript beim Ausschalten']].forEach(([cls, key, label]) => {
      this._playerSection.querySelectorAll('.' + cls).forEach(sel => {
        const e = sel.dataset.entity;
        sel.hass     = this._hass;
        sel.selector = scriptSelector;
        sel.label    = label;
        sel.value    = (this._config.players[e] || {})[key] || '';
        sel.addEventListener('value-changed', (ev) => {
          ev.stopPropagation();
          this._config.players = { ...this._config.players,
            [e]: { ...(this._config.players[e] || {}), [key]: ev.detail.value || '' } };
          this._dispatch();
        });
      });
    });

    this._playerSection.querySelectorAll('.player-hidden').forEach(cb => {
      cb.addEventListener('change', () => {
        const e = cb.dataset.entity;
        this._config.players = { ...this._config.players, [e]: { ...(this._config.players[e]||{}), hidden: cb.checked } };
        this._dispatch();
      });
    });
    this._playerSection.querySelectorAll('.player-always-off').forEach(cb => {
      cb.addEventListener('change', () => {
        const e = cb.dataset.entity;
        this._config.players = { ...this._config.players, [e]: { ...(this._config.players[e]||{}), always_off: cb.checked } };
        this._dispatch();
      });
    });
  }

  _dispatch() {
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
  }
}

customElements.define('am-search-card-editor', AmSearchCardEditor);

// ── Registrierung ─────────────────────────────────────────────────────────────

if (!customElements.get('am-search-card')) customElements.define('am-search-card', AmSearchCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type:        'am-search-card',
  name:        'Apple Music Search',
  description: 'Suche und Wiedergabe für die Apple Music Custom Integration',
  preview:     false,
});
