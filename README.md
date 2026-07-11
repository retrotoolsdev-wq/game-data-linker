# Game Data Linker

A [Millennium](https://steambrew.app/) plugin that makes non-Steam games look and feel like real Steam games. Link any non-Steam shortcut to a **Steam AppID, an Epic Games store link, or an Xbox store link** and its library page fills with that game's real data - artwork, news, patch notes, friend activity, achievements, community content, and more.

[![ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/retrotools)

## Features

- **Automatic artwork** - hero banner, logo, portrait grid, and wide capsule are downloaded from Steam's CDN and applied to the shortcut
- **Real activity feed** - friend achievement unlocks, shared screenshots/videos, reviews, wishlists, and "now owns" events for the linked game, rendered with Steam's own styling
- **Post status updates** - the "Say something about this game to your friends..." box works for real, posting to your friends' activity feeds under the linked game
- **Achievements** - real progress for games you own (play bar stat + sidebar panel), or the game's achievement count otherwise
- **News** - the 3 newest partner events with their real cover images, event-type labels, and Major Update styling, localized to your Steam language
- **Friends who play** - avatars and names of friends who own the linked game
- **Community content** - top screenshots, artwork, and guides from the community hub
- **Pixel-accurate** - injected UI uses Steam's own CSS classes (resolved at runtime), so it matches the native library pages exactly and follows your Steam language
- **Epic Games & Xbox** - link Epic and Xbox games too. Sign in with your Epic or Xbox account to show friends who play; Xbox also shows real friend avatars/gamertags and your actual achievement progress. Patch notes and clean transparent logos are pulled in automatically

## Installation

1. Install [Millennium](https://steambrew.app/)
2. Clone or download this repository into your Steam plugins folder:
   ```
   <Steam>\plugins\game-data-linker
   ```
3. Restart Steam and enable **Game Data Linker** in the Millennium plugin settings

## Usage

1. Add a non-Steam game to your library as usual (Add a Game → Add a Non-Steam Game)
2. Right-click it → **Properties**
3. In the **Linked Game** section, paste any of the following and hit **Save**:
   - a Steam AppID or store link (e.g. `https://store.steampowered.com/app/4000/Garrys_Mod/`)
   - an Epic Games store link (e.g. `https://store.epicgames.com/p/alan-wake-2`)
   - an Xbox store link (e.g. `https://www.xbox.com/games/store/sea-of-thieves/9p2n57mc619k`)
4. Open the game's library page - artwork and data apply automatically

Use **Clear** in the same Properties section to unlink and remove the custom artwork.

### Epic Games & Xbox

- **Epic** - the first time you link an Epic game you'll be prompted to sign in with your Epic account (used to list friends who play). Game data and artwork work without signing in.
- **Xbox** - sign in with your Microsoft / Xbox account via a one-time device code (`microsoft.com/link`) to show your real friends and achievement progress.
- **SteamGridDB key** - Epic and Xbox don't provide clean transparent logos, so linking your first Xbox game asks once for a free [SteamGridDB](https://www.steamgriddb.com/) API key (Preferences → API). It's stored locally and reused after that.

## Building from source

The plugin ships prebuilt in `.millennium/Dist/`. To rebuild after editing `frontend/index.tsx`:

```
npm install
npm run build
```

Backend changes (`backend/main.lua`) only need a Steam restart.

## How it works

- Game metadata comes from the Steam store `appdetails` API; news from the Steam news hub (partner events); community content from the community hub
- Friend activity is read from the Steam client's own activity store (`appActivityStore`) for the linked AppID
- Achievement progress uses the client's `appAchievementProgressCache`, so games you own show your real unlock counts
- Injected DOM reuses Steam's hashed CSS-module classes, resolved at runtime via Millennium's webpack tools with fallbacks for the current Steam build

## Support

These tools are free and open source. If you get some use out of them and want to toss a few bucks my way for coffee or hosting, it's appreciated but never expected: **[ko-fi.com/retrotools](https://ko-fi.com/retrotools)**

## License

MIT - see [LICENSE](LICENSE).
