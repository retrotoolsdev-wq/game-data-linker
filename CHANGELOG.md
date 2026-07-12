# Changelog

## v1.0.1 - Epic Games and Xbox support

Game Data Linker now works with Epic Games Store and Xbox games, not just Steam. Paste an Epic or Xbox store link into a non-Steam shortcut and its library page fills in like a Steam-linked game.

### Added

- Epic Games Store support. Paste an Epic store link to link a shortcut. Sign in with your Epic account to show friends who play. Metadata, achievements, artwork, screenshots, and news load into the library page in Steam's style.
- Xbox support. Paste an Xbox store link to link a shortcut. Sign in with your Microsoft or Xbox account through a device-code flow to show your real friends (with avatars and gamertags) and your actual achievement progress. Metadata, artwork, and screenshots apply automatically.
- Patch notes for Epic and Xbox games, shown as update cards in Steam's format, matched from the game's Steam listing when available.
- Clean transparent logos from SteamGridDB, so games without a built-in logo still get one. Linking your first Xbox game asks once for a free SteamGridDB API key.

### Fixed

- Better game matching for lesser-known Epic titles (handles the extra ID suffix in store links).
- Artwork refreshes right after linking, instead of only after leaving the page and returning.
- Logos apply for games whose store listing has no clean logo.

### Notes

- Epic does not provide profile pictures or your personal achievement unlock state, so Epic friends show initials and achievements show global rarity instead of your progress. Xbox provides both.
- Not every game is in every catalog. When a source does not have a game, that section is skipped.

## v1.0.1

- Detect Steam UI language reliably and cache news per language.
- Fix community content cards and links; invalidate stale cached entries.
- Fix backend argument order on Linux and open links inside the Steam client.

## v1.0.0

- Initial release: link non-Steam shortcuts to a Steam AppID to show real artwork, news, friend activity, achievements, and community content in the library.
