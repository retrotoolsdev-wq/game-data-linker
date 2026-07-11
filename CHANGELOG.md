# Changelog

## v1.1.0 — Epic Games & Xbox support

Game Data Linker now works with **Epic Games Store** and **Xbox** games, not just Steam. Paste an Epic or Xbox store link into a non-Steam shortcut and its library page fills in just like a Steam-linked game.

### Added

- **Epic Games Store support** — paste an Epic store link (e.g. `https://store.epicgames.com/p/<game>`) to link a shortcut. Sign in with your Epic account to show friends who play; metadata, achievements, artwork, screenshots, and news populate the library page in Steam's native style.
- **Xbox support** — paste an Xbox store link (e.g. `https://www.xbox.com/games/store/<game>/<id>`) to link a shortcut. Sign in with your Microsoft / Xbox account via a secure device-code flow to show your **real friends (with avatars and gamertags)** and your **actual achievement progress**. Metadata, artwork, and screenshots apply automatically.
- **Patch notes** — Epic and Xbox library pages now show real patch-notes / update cards in Steam's native format, matched from the game's Steam listing when available.
- **Clean transparent logos** — game logos are sourced from [SteamGridDB](https://www.steamgriddb.com/) so titles that don't ship a proper logo still get a crisp wordmark. Linking your first Xbox game prompts once for a free SteamGridDB API key.

### Fixed

- More reliable game resolution for lesser-known Epic titles (store-link disambiguator suffixes are handled).
- Artwork now refreshes immediately after linking, instead of only after navigating away and back.
- Logos apply correctly for games whose store listing lacks a clean logo image.

### Notes

- Epic does not expose profile pictures or per-user achievement unlock state, so Epic friends show initials and achievements show global rarity rather than your unlock status. Xbox provides both.
- Not every game exists in every catalog; each data source falls back gracefully when a game isn't found there.

## v1.0.1

- Detect Steam UI language reliably and cache news per language.
- Fix community content cards and links; invalidate stale cached entries.
- Fix backend argument order on Linux and open links inside the Steam client.

## v1.0.0

- Initial release: link non-Steam shortcuts to a Steam AppID to show real artwork, news, friend activity, achievements, and community content in the library.
