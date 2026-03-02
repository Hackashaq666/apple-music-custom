"""Constants for the Apple Music integration."""

DOMAIN = "apple_music"

CONF_HOST = "host"
CONF_PORT = "port"

DEFAULT_PORT = 8181
DEFAULT_NAME = "Apple Music"

# How often HA polls the server for state
SCAN_INTERVAL_SECONDS = 5

# Media browser node identifiers
BROWSE_ROOT       = "root"
BROWSE_PLAYLISTS  = "playlists"
BROWSE_ARTISTS    = "artists"
BROWSE_ALBUMS     = "albums"

# Separator used in browse media_content_id paths
BROWSE_SEP = "||"
