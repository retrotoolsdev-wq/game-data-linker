local logger     = require("logger")
local millennium = require("millennium")
local http       = require("http")
local cjson      = require("json")
local fs         = require("fs")

-- ── Config path ────────────────────────────────────────────────────────
-- Use the plugin's own directory (parent of backend/) to store mappings

-- Resolve the plugin folder name dynamically from plugin.json
local function get_plugin_folder_name()
    -- Try to read plugin.json from the plugin directory to get the folder name
    local backend_dir = MILLENNIUM_PLUGIN_SECRET_BACKEND_ABSOLUTE or ""
    local plugin_dir = fs.parent_path(backend_dir)
    if plugin_dir and plugin_dir ~= "" then
        -- Extract just the folder name from the full path
        local folder_name = plugin_dir:match("([^/\\]+)$")
        if folder_name and folder_name ~= "" then
            return folder_name
        end
    end
    -- Fallback to plugin name from plugin.json convention
    return "game-data-linker"
end

local function get_config_path()
    local backend_dir = MILLENNIUM_PLUGIN_SECRET_BACKEND_ABSOLUTE or ""
    local plugin_dir = fs.parent_path(backend_dir)
    if not plugin_dir or plugin_dir == "" then
        -- Fallback: construct from steam_path using dynamic folder name
        local steam = millennium.steam_path()
        local folder_name = get_plugin_folder_name()
        plugin_dir = fs.join(steam, "plugins", folder_name)
        logger:warn("Using fallback config path: " .. plugin_dir)
    end
    local path = fs.join(plugin_dir, "mappings.json")
    logger:info("Config path resolved to: " .. tostring(path))
    return path
end

-- ── Persistence helpers ────────────────────────────────────────────────
local function read_mappings()
    local path = get_config_path()
    if not fs.exists(path) then
        return {}
    end
    -- Read file via io (available in LuaJIT)
    local f, err = io.open(path, "r")
    if not f then
        logger:warn("Could not open mappings file: " .. tostring(err))
        return {}
    end
    local content = f:read("*a")
    f:close()
    if not content or content == "" then
        return {}
    end
    local ok, data = pcall(cjson.decode, content)
    if not ok then
        logger:warn("Failed to parse mappings JSON: " .. tostring(data))
        return {}
    end
    return data
end

local function write_mappings(data)
    local path = get_config_path()
    -- Ensure parent directory exists
    local dir = fs.parent_path(path)
    if not fs.exists(dir) then
        fs.create_directories(dir)
    end
    local json_str = cjson.encode(data)
    local f, err = io.open(path, "w")
    if not f then
        logger:warn("Could not write mappings file: " .. tostring(err))
        return false
    end
    f:write(json_str)
    f:close()
    return true
end

-- ── Frontend-callable functions ────────────────────────────────────────

function save_mapping(non_steam_id, steam_id)
    logger:info("Saving mapping: " .. tostring(non_steam_id) .. " -> " .. tostring(steam_id))
    local data = read_mappings()
    data[tostring(non_steam_id)] = tostring(steam_id)
    local ok = write_mappings(data)
    if ok then
        return "ok"
    end
    return "error"
end

function remove_mapping(non_steam_id)
    logger:info("Removing mapping for: " .. tostring(non_steam_id))
    local data = read_mappings()
    data[tostring(non_steam_id)] = nil
    local ok = write_mappings(data)
    if ok then
        return "ok"
    end
    return "error"
end

function get_all_mappings()
    local data = read_mappings()
    return cjson.encode(data)
end

function fetch_game_data(steam_app_id)
    local url = "https://store.steampowered.com/api/appdetails?appids=" .. tostring(steam_app_id)
    logger:info("Fetching game data from: " .. url)

    local res, err = http.get(url, {
        headers = { ["Accept"] = "application/json" },
        timeout = 15
    })

    if not res then
        logger:warn("HTTP request failed: " .. tostring(err))
        return cjson.encode({ error = "Request failed: " .. tostring(err) })
    end

    if res.status ~= 200 then
        logger:warn("HTTP status " .. tostring(res.status) .. " for appid " .. tostring(steam_app_id))
        return cjson.encode({ error = "HTTP " .. tostring(res.status) })
    end

    -- The Steam API returns { "<appid>": { "success": true, "data": { ... } } }
    local ok, body = pcall(cjson.decode, res.body)
    if not ok then
        logger:warn("Failed to parse Steam API response: " .. tostring(body))
        return cjson.encode({ error = "Parse error" })
    end

    local app_data = body[tostring(steam_app_id)]
    if not app_data or not app_data.success then
        logger:warn("Steam API returned unsuccessful for appid " .. tostring(steam_app_id))
        return cjson.encode({ error = "App not found or API returned unsuccessful" })
    end

    -- Return just the data portion
    return cjson.encode(app_data.data)
end

-- Frontend debug logger - single string param to avoid argument-passing issues
function fe_log(msg)
    logger:info("[FE] " .. tostring(msg))
    return "ok"
end

-- fetch_image removed - images will be fetched from frontend directly

function fetch_news(steam_app_id)
    local url = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v0002/?appid="
        .. tostring(steam_app_id) .. "&count=10&maxlength=300&format=json"
    logger:info("Fetching news from: " .. url)

    local res, err = http.get(url, {
        headers = { ["Accept"] = "application/json" },
        timeout = 15
    })

    if not res then
        return cjson.encode({ error = "Request failed: " .. tostring(err) })
    end

    if res.status ~= 200 then
        return cjson.encode({ error = "HTTP " .. tostring(res.status) })
    end

    local ok, body = pcall(cjson.decode, res.body)
    if not ok then
        return cjson.encode({ error = "Parse error" })
    end

    local news = body and body.appnews and body.appnews.newsitems
    if not news then
        return cjson.encode({ items = {} })
    end

    return cjson.encode({ items = news })
end

-- ── Partner events (the native news source: cover images, event types,
-- localized to the user's language) ─────────────────────────────────────

local function html_unescape(s)
    return (s:gsub("&quot;", '"'):gsub("&#39;", "'"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&amp;", "&"))
end

-- Scrape the Steam news-hub page for an appid and return a Lua array of native
-- event items (title/contents/date/event_type/cover image). Shared by the
-- Steam-linked path and the Epic/Xbox cross-platform patch-notes lookup.
local function scrape_partner_events(appid, lang, max)
    appid = tostring(appid)
    lang = tostring(lang or "english")
    max = max or 10

    -- The old ajaxgetpartnereventspage endpoint is gone; the news hub page
    -- embeds the same event data in its data-initialEvents attribute
    local url = "https://store.steampowered.com/news/app/" .. appid .. "?l=" .. lang
    logger:info("Fetching partner events: " .. url)

    local ok, res = pcall(http.get, url, {
        headers = { ["Accept"] = "text/html,*/*" },
        timeout = 20
    })
    if not ok or not res or res.status ~= 200 or not res.body then
        logger:warn("Partner events fetch failed for appid " .. appid)
        return {}
    end

    local marker = 'data-initialEvents="'
    local a = res.body:find(marker, 1, true)
    if not a then
        logger:warn("Partner events: data-initialEvents not found for appid " .. appid)
        return {}
    end
    local vstart = a + #marker
    local vend = res.body:find('"', vstart, true)
    if not vend then return {} end

    local ok2, body = pcall(cjson.decode, html_unescape(res.body:sub(vstart, vend - 1)))
    if not ok2 or type(body) ~= "table" or type(body.events) ~= "table" then
        logger:warn("Partner events parse failed for appid " .. appid)
        return {}
    end

    local items = {}
    for _, ev in ipairs(body.events) do
        if type(ev) == "table" then
            local ann = (type(ev.announcement_body) == "table") and ev.announcement_body or {}
            local item = {
                gid = tostring(ev.gid or ann.gid or ""),
                title = ann.headline or ev.event_name or "",
                contents = ann.body or "",
                date = ann.posttime or ev.rtime32_start_time or 0,
                event_type = ev.event_type or 0,
                image = "",
            }
            local clanid = tostring(ann.clanid or "")

            -- Cover image lives in jsondata (a JSON string) as a localized
            -- array with holes; scan indices manually since decoders differ
            -- in how they represent nulls
            if type(ev.jsondata) == "string" and #ev.jsondata > 2 and clanid ~= "" then
                local okj, jd = pcall(cjson.decode, ev.jsondata)
                if okj and type(jd) == "table" then
                    local img = nil
                    for _, field in ipairs({ "localized_capsule_image", "localized_title_image" }) do
                        local arr = jd[field]
                        if not img and type(arr) == "table" then
                            for i = 1, 30 do
                                local v = arr[i]
                                if type(v) == "string" and #v > 0 then
                                    img = v
                                    break
                                end
                            end
                        end
                    end
                    if img then
                        item.image = "https://clan.akamai.steamstatic.com/images/" .. clanid .. "/" .. img
                    end
                end
            end

            table.insert(items, item)
            if #items >= max then break end
        end
    end

    logger:info("Partner events: " .. tostring(#items) .. " item(s) for appid " .. appid)
    return items
end

function fetch_partner_events(steam_app_id, language)
    local appid = tostring(steam_app_id)
    local lang = tostring(language or "english")
    -- Some Millennium builds (seen on Linux) map named JS arguments onto Lua
    -- positionals in a different order; detect the swap and undo it
    if not appid:match("^%d+$") and lang:match("^%d+$") then
        appid, lang = lang, appid
    end
    lang = lang:gsub("[^%w_]", "")
    if lang == "" then lang = "english" end
    return cjson.encode({ items = scrape_partner_events(appid, lang, 10) })
end

-- ── Published file previews (screenshots/videos shared by friends) ─────
local published_preview_cache = {}

function fetch_published_file_previews(file_ids_csv)
    local results = {}
    for id in tostring(file_ids_csv):gmatch("(%d+)") do
        if #results >= 12 then break end
        if published_preview_cache[id] then
            table.insert(results, published_preview_cache[id])
        else
            local url = "https://steamcommunity.com/sharedfiles/filedetails/?id=" .. id
            local ok, res = pcall(http.get, url, {
                headers = { ["Accept"] = "text/html,*/*" },
                timeout = 10
            })
            local entry = { id = id, image = "" }
            if ok and res and res.status == 200 and res.body then
                local img = res.body:match('<meta%s+property="og:image"%s+content="([^"]+)"')
                if img then entry.image = img:gsub("&amp;", "&") end
            end
            published_preview_cache[id] = entry
            table.insert(results, entry)
        end
    end
    logger:info("Published file previews: " .. tostring(#results) .. " resolved")
    return cjson.encode(results)
end

-- ── Friend review scraping (from public community profiles) ────────────
local review_cache = {}

local function strip_html(s)
    s = s:gsub("<br%s*/?>", "\n"):gsub("<[^>]+>", "")
    s = s:gsub("&quot;", '"'):gsub("&#39;", "'"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&nbsp;", " "):gsub("&amp;", "&")
    return s:match("^%s*(.-)%s*$") or ""
end

function fetch_friend_review(steam_id64, steam_app_id)
    local sid = tostring(steam_id64):match("(%d+)") or ""
    local appid = tostring(steam_app_id):match("(%d+)") or ""
    -- SteamID64s are 17 digits, appids far shorter; undo swapped arguments
    -- (same Linux argument-order quirk as fetch_partner_events)
    if #sid < 15 and #appid >= 15 then
        sid, appid = appid, sid
    end
    local key = sid .. "_" .. appid
    if review_cache[key] then return review_cache[key] end

    local public_url = "https://steamcommunity.com/profiles/" .. sid .. "/recommended/" .. appid .. "/"
    local out = { found = false, url = public_url }

    -- l=english pins the rating summary text so voted_up detection is stable
    local ok, res = pcall(http.get, public_url .. "?l=english", {
        headers = { ["Accept"] = "text/html,*/*" },
        timeout = 10
    })
    if ok and res and res.status == 200 and res.body then
        local body = res.body
        local rating = body:match('<div class="ratingSummary">%s*(.-)%s*</div>')
        local playtime = body:match('<div class="playTime">%s*(.-)%s*</div>')
        local text = body:match('<div id="ReviewText">(.-)</div>')
        if rating and text then
            out.found = true
            out.voted_up = (rating:lower():find("not recommended", 1, true) == nil)
            out.rating = strip_html(rating)
            out.hours = playtime and strip_html(playtime) or ""
            out.text = strip_html(text)
        end
    end

    local encoded = cjson.encode(out)
    review_cache[key] = encoded
    return encoded
end

-- ── Friend persona fetching (batch, cached) ───────────────────────────
local friend_persona_cache = {}

function fetch_friend_personas(steam_ids_csv)
    local ids = {}
    for id in tostring(steam_ids_csv):gmatch("(%d+)") do
        if #ids < 30 then
            table.insert(ids, id)
        end
    end

    local results = {}
    for _, sid in ipairs(ids) do
        if friend_persona_cache[sid] then
            table.insert(results, friend_persona_cache[sid])
        else
            local url = "https://steamcommunity.com/profiles/" .. sid .. "/?xml=1"
            local ok_req, res = pcall(http.get, url, { timeout = 8 })
            local entry = { steamid = sid, name = "", avatar = "" }
            if ok_req and res and res.status == 200 and res.body then
                local name = res.body:match("<steamID><!%[CDATA%[(.-)%]%]></steamID>")
                if not name then name = res.body:match("<steamID>(.-)</steamID>") end
                local avatar = res.body:match("<avatarMedium><!%[CDATA%[(.-)%]%]></avatarMedium>")
                if not avatar then avatar = res.body:match("<avatarMedium>(.-)</avatarMedium>") end
                entry.name = name or ""
                entry.avatar = avatar or ""
            end
            friend_persona_cache[sid] = entry
            table.insert(results, entry)
        end
    end

    return cjson.encode(results)
end

-- ── Community content fetching (screenshots, artwork, guides) ─────────

-- Helper to parse apphub_Card blocks from community hub HTML.
-- Uses id="apphub_Card_" as the unique delimiter since the class name
-- "apphub_Card" also appears in dozens of child element classes.
local function parse_hub_cards(html, fallback_type, items)
    -- Debug: log bytes around position 100-200 to check encoding
    logger:info("parse_hub_cards: html length=" .. tostring(#html) .. " first200=" .. html:sub(1, 200))

    -- Try multiple delimiter patterns - the Millennium http module may return
    -- the HTML with different quoting or the id may use single quotes
    local DELIM = 'id="apphub_Card_'
    local first = html:find(DELIM, 1, true)
    if not first then
        -- Try single quotes
        DELIM = "id='apphub_Card_"
        first = html:find(DELIM, 1, true)
    end
    if not first then
        -- Try without quotes (some parsers strip them)
        DELIM = 'id=apphub_Card_'
        first = html:find(DELIM, 1, true)
    end
    if not first then
        -- Try to find apphub_Card_ anywhere to see if it exists at all
        local anyPos = html:find('apphub_Card_', 1, true)
        if anyPos then
            logger:info("parse_hub_cards: found apphub_Card_ at pos " .. tostring(anyPos) .. " context: " .. html:sub(math.max(1, anyPos - 30), anyPos + 60))
        else
            logger:info("parse_hub_cards: NO apphub_Card_ found at all in " .. tostring(#html) .. " bytes")
            -- Check for apphub_Card with a space (class name)
            local classPos = html:find('apphub_Card ', 1, true)
            if classPos then
                logger:info("parse_hub_cards: found class 'apphub_Card ' at pos " .. tostring(classPos) .. " context: " .. html:sub(math.max(1, classPos - 50), classPos + 100))
            end
        end
        return
    end
    logger:info("parse_hub_cards: using delimiter '" .. DELIM .. "' first match at pos " .. tostring(first))

    local search_pos = first
    while #items < 20 do
        local card_start = html:find(DELIM, search_pos, true)
        if not card_start then break end

        local next_card = html:find(DELIM, card_start + 20, true)
        local card_end = next_card and (next_card - 1) or #html
        local card = html:sub(card_start, card_end)

        local item = {}

        -- Detect type from apphub_CardContentType div
        local content_type = card:match('apphub_CardContentType[^"]*"[^>]*>%s*(%w+)')
        if content_type then
            local ct = content_type:lower()
            if ct == "guide" then
                item.type = "guide"
                item.label = "Guide"
            elseif ct == "artwork" then
                item.type = "screenshot"  -- treat artwork like screenshots for rendering
            else
                item.type = fallback_type or "screenshot"
            end
        else
            item.type = fallback_type or "screenshot"
        end

        -- Main preview image (screenshots/artwork)
        item.image = card:match('apphub_CardContentPreviewImage" src="([^"]+)"')
        -- Guide image
        if not item.image then
            item.image = card:match('apphub_CardContentGuideImage" src="([^"]+)"')
        end
        -- Generic fallback
        if not item.image then
            item.image = card:match('<img[^>]+src="(https://images%.steamusercontent%.com/[^"]+)"')
        end

        -- Title: screenshots use apphub_CardContentTitle, guides use apphub_CardContentGuideTitle
        local raw_title = card:match('apphub_CardContentTitle[^"]*"[^>]*>%s*(.-)%s*</')
        if not raw_title then
            -- Guide title: text after the <img> inside apphub_CardContentGuideTitle
            raw_title = card:match('apphub_CardContentGuideTitle[^>]*>.-</img>%s*(.-)%s*</div')
            if not raw_title then
                -- Guide title: text content (may contain img tag, strip it)
                local gtblock = card:match('apphub_CardContentGuideTitle[^>]*>(.-)</div')
                if gtblock then
                    raw_title = gtblock:gsub('<[^>]+>', ''):match('^%s*(.-)%s*$')
                end
            end
        end
        if raw_title and raw_title ~= "" then
            item.title = raw_title:gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&#39;", "'"):gsub("&quot;", '"'):gsub("&nbsp;", " "):gsub("%s+$", "")
        end

        -- Description (guides only)
        local raw_desc = card:match('apphub_CardContentGuideDesc[^>]*>(.-)</div')
        if raw_desc then
            item.description = raw_desc:gsub("<[^>]+>", ""):gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&#39;", "'"):gsub("&quot;", '"'):gsub("&nbsp;", " "):match("^%s*(.-)%s*$")
        end

        -- Author avatar (inside appHubIconHolder div)
        item.author_avatar = card:match('appHubIconHolder[^>]*><img src="([^"]+)"')

        -- Author name
        item.author_name = card:match('apphub_CardContentAuthorName.-<a[^>]*>([^<]*)</a>')
        if item.author_name then
            item.author_name = item.author_name:gsub("&amp;", "&"):gsub("&#39;", "'"):gsub("%s+$", "")
        end

        -- Link from data-modal-content-url: it sits on the card's OPENING tag
        -- before the id attribute, so it is NOT inside this chunk - the next
        -- card's link is, which used to send clicks to the neighboring item.
        -- Search backward from this card's id and take the closest match.
        item.link = nil
        local window_start = (card_start > 3000) and (card_start - 3000) or 1
        local window = html:sub(window_start, card_start)
        for m in window:gmatch('data%-modal%-content%-url="([^"]*)"') do
            item.link = m
        end
        if item.link then
            item.link = item.link:gsub("&amp;", "&")
        end

        if item.image and item.image ~= "" then
            table.insert(items, item)
            if #items <= 3 then
                logger:info("Parsed item #" .. tostring(#items) .. ": type=" .. tostring(item.type)
                    .. " title=" .. tostring(item.title or ""):sub(1, 40)
                    .. " author=" .. tostring(item.author_name or "")
                    .. " link=..." .. tostring(item.link or ""):sub(-24))
            end
        end

        search_pos = card_start + 20
    end
end

function fetch_community_content(steam_app_id)
    local appid = tostring(steam_app_id)
    local items = {}

    -- Fetch screenshots/artwork
    local ss_url = "https://steamcommunity.com/app/" .. appid
        .. "/homecontent/?l=english&browsefilter=toprated&numperpage=10"
        .. "&appid=" .. appid .. "&appHubSubSection=2&forceanon=1"
    logger:info("Fetching community screenshots for appid: " .. appid)
    local ok_ss, ss_res = pcall(http.get, ss_url, {
        headers = { ["Accept"] = "text/html,*/*" },
        timeout = 12
    })
    if ok_ss and ss_res and ss_res.status == 200 and ss_res.body then
        parse_hub_cards(ss_res.body, "screenshot", items)
        logger:info("Screenshots HTML length: " .. tostring(#ss_res.body) .. ", parsed so far: " .. tostring(#items))
    else
        logger:warn("Screenshots fetch failed or empty")
    end

    -- Fetch guides (appHubSubSection=9 is guides; 4 is artwork/videos)
    local gg_url = "https://steamcommunity.com/app/" .. appid
        .. "/homecontent/?l=english&browsefilter=toprated&numperpage=10"
        .. "&appid=" .. appid .. "&appHubSubSection=9&forceanon=1"
    logger:info("Fetching community guides for appid: " .. appid)
    local ok_gg, gg_res = pcall(http.get, gg_url, {
        headers = { ["Accept"] = "text/html,*/*" },
        timeout = 12
    })
    if ok_gg and gg_res and gg_res.status == 200 and gg_res.body then
        parse_hub_cards(gg_res.body, "guide", items)
        logger:info("Guides HTML length: " .. tostring(#gg_res.body) .. ", parsed so far: " .. tostring(#items))
    else
        logger:warn("Guides fetch failed or empty")
    end

    logger:info("Total community content items: " .. tostring(#items))
    return cjson.encode({ items = items })
end

-- ── Active user detection ──────────────────────────────────────────────
-- Parse loginusers.vdf to find the most-recently-logged-in Steam user,
-- then convert SteamID64 → 32-bit account ID (the userdata folder name).

local function get_active_account_id()
    local steam_path = millennium.steam_path()
    local vdf_path = fs.join(steam_path, "config", "loginusers.vdf")
    if not fs.exists(vdf_path) then
        logger:warn("loginusers.vdf not found at " .. vdf_path)
        return nil
    end
    local f = io.open(vdf_path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()

    local current_id = nil
    local most_recent_id = nil
    for line in content:gmatch("[^\r\n]+") do
        local id64 = line:match('^%s*"(%d%d%d%d%d%d%d%d%d+)"%s*$')
        if id64 then
            current_id = id64
        end
        if current_id and line:match('"MostRecent"%s*"1"') then
            most_recent_id = current_id
        end
    end

    if not most_recent_id then
        logger:warn("No MostRecent user found in loginusers.vdf")
        return nil
    end

    -- Convert SteamID64 string to 32-bit account ID via digit-by-digit modulo.
    -- Lua doubles lack the precision for 17-digit ints, so we compute mod 2^32
    -- one digit at a time, which keeps intermediates small.
    local mod_val = 4294967296  -- 2^32
    local result = 0
    for i = 1, #most_recent_id do
        result = (result * 10 + tonumber(most_recent_id:sub(i, i))) % mod_val
    end

    logger:info("Active Steam account ID: " .. tostring(result) .. " (from " .. most_recent_id .. ")")
    return tostring(math.floor(result))
end

-- ── Artwork saving to Steam grid folder ────────────────────────────────

function save_artwork(shortcut_app_id, steam_app_id)
    local account_id = get_active_account_id()
    if not account_id then
        return cjson.encode({ error = "Could not determine active Steam user" })
    end

    local steam_path = millennium.steam_path()
    local grid_dir = fs.join(steam_path, "userdata", account_id, "config", "grid")

    if not fs.exists(grid_dir) then
        fs.create_directories(grid_dir)
    end

    local sid = tostring(shortcut_app_id)
    local cdn_base = "https://cdn.akamai.steamstatic.com/steam/apps/" .. tostring(steam_app_id)

    -- { CDN url, filename suffix, extension }
    local images = {
        { cdn_base .. "/library_600x900.jpg", "p",     "jpg" },   -- Portrait grid
        { cdn_base .. "/library_hero.jpg",    "_hero", "jpg" },   -- Hero banner
        { cdn_base .. "/logo.png",            "_logo", "png" },   -- Logo
        { cdn_base .. "/header.jpg",          "",      "jpg" },   -- Wide capsule
    }

    local saved = 0
    for _, img in ipairs(images) do
        local url, suffix, ext = img[1], img[2], img[3]
        local filename = sid .. suffix .. "." .. ext
        local filepath = fs.join(grid_dir, filename)

        logger:info("Downloading artwork: " .. url)
        local ok, res = pcall(http.get, url, { timeout = 30 })
        if ok and res and res.status == 200 and res.body and #res.body > 0 then
            -- Remove conflicting files with different extensions
            for _, old_ext in ipairs({"jpg", "jpeg", "png"}) do
                if old_ext ~= ext then
                    local old_path = fs.join(grid_dir, sid .. suffix .. "." .. old_ext)
                    if fs.exists(old_path) then
                        os.remove(old_path)
                        logger:info("Removed old grid file: " .. old_path)
                    end
                end
            end

            local f_out = io.open(filepath, "wb")
            if f_out then
                f_out:write(res.body)
                f_out:close()
                saved = saved + 1
                logger:info("Saved artwork: " .. filepath .. " (" .. tostring(#res.body) .. " bytes)")
            else
                logger:warn("Could not write artwork file: " .. filepath)
            end
        else
            local err_msg = "failed"
            if ok and res then err_msg = "HTTP " .. tostring(res.status) end
            logger:warn("Artwork download " .. err_msg .. ": " .. url)
        end
    end

    logger:info("Artwork save complete: " .. tostring(saved) .. "/4 for shortcut " .. sid)
    return cjson.encode({ saved = saved, account_id = account_id })
end

function clear_artwork(shortcut_app_id)
    local account_id = get_active_account_id()
    if not account_id then
        return cjson.encode({ error = "Could not determine active Steam user" })
    end

    local steam_path = millennium.steam_path()
    local grid_dir = fs.join(steam_path, "userdata", account_id, "config", "grid")
    local sid = tostring(shortcut_app_id)

    local removed = 0
    for _, suffix in ipairs({ "p", "_hero", "_logo", "" }) do
        for _, ext in ipairs({ "jpg", "jpeg", "png" }) do
            local filepath = fs.join(grid_dir, sid .. suffix .. "." .. ext)
            if fs.exists(filepath) then
                os.remove(filepath)
                removed = removed + 1
                logger:info("Removed grid file: " .. filepath)
            end
        end
    end

    return cjson.encode({ removed = removed })
end

-- ══════════════════════════════════════════════════════════════════════
-- Epic Games Store support
-- ══════════════════════════════════════════════════════════════════════
-- Metadata + achievements come from the community egdata.app API (no auth).
-- Friends usernames require the user to link their Epic account via the
-- launcher OAuth flow (same public client Legendary/Heroic use).

local function url_encode(s)
    return (tostring(s):gsub("[^%w%-_%.~]", function(c)
        return string.format("%%%02X", string.byte(c))
    end))
end

local RFC822_MONTHS = { Jan = 1, Feb = 2, Mar = 3, Apr = 4, May = 5, Jun = 6, Jul = 7, Aug = 8, Sep = 9, Oct = 10, Nov = 11, Dec = 12 }
local function rfc822_to_epoch(s)
    -- e.g. "Mon, 06 Jul 2026 21:15:27 GMT"
    local d, mon, y, h, mi, se = tostring(s or ""):match("(%d+)%s+(%a+)%s+(%d+)%s+(%d+):(%d+):(%d+)")
    if not d then return 0 end
    local ok, t = pcall(os.time, {
        year = tonumber(y), month = RFC822_MONTHS[mon] or 1, day = tonumber(d),
        hour = tonumber(h), min = tonumber(mi), sec = tonumber(se),
    })
    return (ok and t) and t or 0
end

-- The Millennium http module's exact POST signature isn't documented for this
-- build, so try the plausible shapes in order and use whichever returns a
-- response table with a status field.
local function http_post(url, headers, body, timeout)
    timeout = timeout or 20
    -- Millennium's exact POST binding/signature isn't documented for this build,
    -- and a bare http.post here sends a GET (Epic replies 405). So force
    -- method="POST" and only accept a 2xx; a 4xx means that shape didn't POST
    -- correctly, so keep trying. Only invoke bindings that actually exist to
    -- avoid calling a mismatched native function (which can hard-crash the VM).
    local calls = {}
    if type(http.request) == "function" then
        calls[#calls + 1] = function() return http.request(url, { method = "POST", data = body, headers = headers, timeout = timeout }) end
        calls[#calls + 1] = function() return http.request(url, { method = "POST", body = body, headers = headers, timeout = timeout }) end
    end
    if type(http.post) == "function" then
        calls[#calls + 1] = function() return http.post(url, { method = "POST", data = body, headers = headers, timeout = timeout }) end
        calls[#calls + 1] = function() return http.post(url, { method = "POST", body = body, headers = headers, timeout = timeout }) end
        calls[#calls + 1] = function() return http.post(url, { data = body, headers = headers, timeout = timeout }) end
        calls[#calls + 1] = function() return http.post(url, { body = body, headers = headers, timeout = timeout }) end
    end
    local firstErr = nil
    for i, fn in ipairs(calls) do
        local ok, res = pcall(fn)
        if ok and type(res) == "table" and res.status then
            logger:info("http_post: variant " .. i .. " -> status " .. tostring(res.status) .. " for " .. url)
            -- 2xx = success. A 400/401 is also a *definitive* answer from the
            -- server (the POST body was received and rejected), so return it
            -- immediately — the body carries the real reason (e.g. an OAuth
            -- "authorization_pending"). Only a 405 means "you sent a GET",
            -- i.e. the wrong binding, so keep trying other shapes.
            if (res.status >= 200 and res.status < 300) or res.status == 400 or res.status == 401 then
                return res
            end
            firstErr = firstErr or res
        end
    end
    if firstErr then return firstErr end
    logger:warn("http_post: no working POST binding for " .. url)
    return nil
end

-- launcherAppClient2 – the public Epic Games Launcher client used by
-- Legendary/Heroic for account-level (non-EOS) auth.
local EPIC_CLIENT_ID     = "34a02cf8f4414e29b15921876da36f9a"
-- Precomputed "basic " + base64("<clientId>:<clientSecret>") so nothing runs
-- at module load time (a load-time crash takes down the whole plugin backend).
local EPIC_BASIC         = "basic MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y="
local EPIC_TOKEN_URL     = "https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token"

local function get_plugin_dir()
    local backend_dir = MILLENNIUM_PLUGIN_SECRET_BACKEND_ABSOLUTE or ""
    local plugin_dir = fs.parent_path(backend_dir)
    if not plugin_dir or plugin_dir == "" then
        plugin_dir = fs.join(millennium.steam_path(), "plugins", get_plugin_folder_name())
    end
    return plugin_dir
end

local function get_epic_auth_path()
    return fs.join(get_plugin_dir(), "epic_auth.json")
end

local function read_epic_auth()
    local path = get_epic_auth_path()
    if not fs.exists(path) then return nil end
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    if not content or content == "" then return nil end
    local ok, data = pcall(cjson.decode, content)
    if not ok or type(data) ~= "table" then return nil end
    return data
end

local function write_epic_auth(tbl)
    local f = io.open(get_epic_auth_path(), "w")
    if not f then return false end
    f:write(cjson.encode(tbl))
    f:close()
    return true
end

-- Return a currently-valid auth table, refreshing the access token if needed.
local function epic_valid_token()
    local a = read_epic_auth()
    if not a or not a.access_token then return nil end
    if a.expires_at and os.time() < (tonumber(a.expires_at) - 300) then
        return a
    end
    -- Token missing an expiry (older store) – assume usable
    if not a.expires_at then return a end
    -- Expired: try refresh
    if a.refresh_token then
        local body = "grant_type=refresh_token&refresh_token=" .. a.refresh_token .. "&token_type=eg1"
        local res = http_post(EPIC_TOKEN_URL, {
            ["Authorization"]  = EPIC_BASIC,
            ["Content-Type"]   = "application/x-www-form-urlencoded",
            ["Accept"]         = "application/json",
        }, body)
        if res and res.status == 200 and res.body then
            local ok, j = pcall(cjson.decode, res.body)
            if ok and type(j) == "table" and j.access_token then
                local merged = {
                    access_token  = j.access_token,
                    refresh_token = j.refresh_token or a.refresh_token,
                    account_id    = j.account_id or a.account_id,
                    display_name  = j.displayName or a.display_name,
                    expires_at    = os.time() + (tonumber(j.expires_in) or 28800),
                }
                write_epic_auth(merged)
                return merged
            end
        end
        logger:warn("Epic token refresh failed")
    end
    return nil
end

function epic_status()
    local a = read_epic_auth()
    if a and a.access_token then
        return cjson.encode({ logged_in = true, display_name = a.display_name or "" })
    end
    return cjson.encode({ logged_in = false })
end

function epic_login_url()
    -- After the user signs in, this page renders JSON containing an
    -- "authorizationCode" they copy back into the plugin.
    local redirect = "https://www.epicgames.com/id/api/redirect?clientId=" .. EPIC_CLIENT_ID .. "&responseType=code"
    local url = "https://www.epicgames.com/id/login?redirectUrl=" .. url_encode(redirect)
    return cjson.encode({ url = url, redirect = redirect })
end

function epic_exchange_code(code)
    -- Accept a raw code, a quoted code, or the whole JSON blob pasted in.
    local c = tostring(code or "")
    local extracted = c:match('authorizationCode"?%s*[:=]%s*"?(%x+)')
    if extracted then c = extracted end
    c = c:gsub("[^%w]", "")
    if c == "" then return cjson.encode({ error = "empty_code" }) end

    local body = "grant_type=authorization_code&code=" .. c .. "&token_type=eg1"
    local res = http_post(EPIC_TOKEN_URL, {
        ["Authorization"] = EPIC_BASIC,
        ["Content-Type"]  = "application/x-www-form-urlencoded",
        ["Accept"]        = "application/json",
    }, body)
    if not res then return cjson.encode({ error = "network" }) end
    if res.status ~= 200 then
        logger:warn("Epic token exchange HTTP " .. tostring(res.status) .. ": " .. tostring(res.body):sub(1, 200))
        return cjson.encode({ error = "auth_failed", status = res.status })
    end
    local ok, j = pcall(cjson.decode, res.body)
    if not ok or type(j) ~= "table" or not j.access_token then
        return cjson.encode({ error = "parse" })
    end
    write_epic_auth({
        access_token  = j.access_token,
        refresh_token = j.refresh_token,
        account_id    = j.account_id,
        display_name  = j.displayName,
        expires_at    = os.time() + (tonumber(j.expires_in) or 28800),
    })
    logger:info("Epic account linked: " .. tostring(j.displayName))
    return cjson.encode({ ok = true, display_name = j.displayName or "" })
end

function epic_logout()
    local path = get_epic_auth_path()
    if fs.exists(path) then os.remove(path) end
    return cjson.encode({ ok = true })
end

-- ── egdata.app: search / metadata / achievements (no auth) ─────────────

local function egdata_get(url)
    local ok, res = pcall(http.get, url, {
        headers = { ["Accept"] = "application/json" },
        timeout = 15,
    })
    if not ok or not res or res.status ~= 200 or not res.body then
        return nil
    end
    local okj, body = pcall(cjson.decode, res.body)
    if not okj then return nil end
    return body
end

-- egdata list responses come back either as a bare array or wrapped under a
-- few different keys depending on endpoint; normalize to a plain array.
local function as_array(body)
    if type(body) ~= "table" then return {} end
    if #body > 0 then return body end
    for _, k in ipairs({ "elements", "hits", "offers", "data", "results" }) do
        if type(body[k]) == "table" then return body[k] end
    end
    return {}
end

function epic_resolve(query)
    local q = tostring(query or "")
    -- Reduce a store URL to a searchable term.
    local slug = q:match("epicgames%.com/[%w%-]*/?p/([%w%-_]+)")
        or q:match("epicgames%.com/[%w%-]*/?product/([%w%-_]+)")
        or q:match("store%.epicgames%.com/[%w%-]+/p/([%w%-_]+)")
    local term = slug and (slug:gsub("[%-_]+", " ")) or q
    term = term:gsub("^%s+", ""):gsub("%s+$", "")
    if term == "" then return cjson.encode({ error = "empty_query" }) end

    -- Epic slugs often carry a disambiguator suffix (e.g. "solarpunk-435b73"),
    -- which breaks the title search. Build query variants, cleanest first.
    local queries, qseen = {}, {}
    local function add_q(s)
        s = tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", "")
        if s ~= "" and not qseen[s:lower()] then
            qseen[s:lower()] = true
            queries[#queries + 1] = s
        end
    end
    if slug and slug ~= "" then
        local stripped = slug:gsub("%-[%da-f][%da-f][%da-f]+$", "") -- drop trailing hex/num id (3+ chars)
        add_q((stripped:gsub("[%-_]+", " ")))
    end
    add_q(term)
    if slug then add_q((slug:gsub("[%-_]+", " "))) end
    add_q(term:match("^(%S+%s+%S+%s+%S+)"))                        -- first three words
    add_q(term:match("^(%S+%s+%S+)"))                             -- first two words
    add_q(term:match("^(%S+)"))                                   -- first word

    -- Gather candidate offers, trying each query only until we get hits.
    local seen, candidates = {}, {}
    local function add_list(body)
        for _, o in ipairs(as_array(body)) do
            if type(o) == "table" and o.id and not seen[tostring(o.id)] then
                seen[tostring(o.id)] = true
                candidates[#candidates + 1] = o
            end
        end
    end
    for _, query in ipairs(queries) do
        if #candidates == 0 then
            add_list(egdata_get("https://api.egdata.app/autocomplete?query=" .. url_encode(query)))
        end
    end
    if #candidates == 0 then
        logger:warn("Epic resolve: no results for '" .. term .. "' (slug '" .. tostring(slug) .. "')")
        return cjson.encode({ error = "not_found" })
    end

    -- Score candidates: exact title match + real achievement sandbox + base game.
    local function norm(s) return tostring(s or ""):lower():gsub("[^%w]", "") end
    local want = norm(queries[1] or term)
    local best, best_ns, best_score = nil, "", -1
    for _, o in ipairs(candidates) do
        local ns = tostring(o.namespace or "")
        local is_sandbox = (ns:match("^%x%x%x%x%x%x%x%x") ~= nil) and #ns >= 30
        local score = 0
        if is_sandbox then score = score + 2 end
        if tostring(o.offerType) == "BASE_GAME" then score = score + 2 end
        if norm(o.title) == want then score = score + 3 end
        if score > best_score then best, best_ns, best_score = o, ns, score end
    end
    if not best then best, best_ns = candidates[1], tostring(candidates[1].namespace or "") end

    logger:info("Epic resolve: '" .. term .. "' -> '" .. tostring(best.title) .. "' (" .. #candidates .. " candidate(s))")
    return cjson.encode({
        id        = tostring(best.id),
        namespace = best_ns or "",
        title     = tostring(best.title or term),
        slug      = tostring(best.urlSlug or best.productSlug or slug or ""),
    })
end

local function pick_key_image(images, types)
    if type(images) ~= "table" then return "" end
    for _, want in ipairs(types) do
        for _, img in ipairs(images) do
            if type(img) == "table" and tostring(img.type) == want and img.url then
                return tostring(img.url)
            end
        end
    end
    return ""
end

function epic_game_data(offer_id)
    local oid = tostring(offer_id or ""):gsub("[^%w]", "")
    if oid == "" then return cjson.encode({ error = "bad_offer" }) end

    local offer = egdata_get("https://api.egdata.app/offers/" .. oid)
    if type(offer) ~= "table" or not offer.title then
        return cjson.encode({ error = "offer_not_found" })
    end

    local images = offer.keyImages
    local out = {
        id          = oid,
        namespace   = tostring(offer.namespace or ""),
        title       = tostring(offer.title or ""),
        description = tostring(offer.longDescription or offer.description or ""),
        developer   = tostring(offer.developerDisplayName or ""),
        publisher   = tostring(offer.publisherDisplayName or ""),
        release     = tostring(offer.releaseDate or offer.effectiveDate or ""),
        slug        = tostring(offer.urlSlug or offer.productSlug or ""),
        tall        = pick_key_image(images, { "DieselStoreFrontTall", "OfferImageTall", "Thumbnail", "ProductLogo" }),
        wide        = pick_key_image(images, { "DieselStoreFrontWide", "OfferImageWide", "DieselGameBoxWide", "featuredMedia" }),
        logo        = pick_key_image(images, { "DieselGameBoxLogo", "ProductLogo" }),
        screenshots = {},
        achievements = {},
        total_achievements = 0,
    }

    -- The /media endpoint carries a proper transparent logo and screenshots
    -- that the offer's keyImages often lack (e.g. Fortnite).
    local media = egdata_get("https://api.egdata.app/offers/" .. oid .. "/media")
    logger:info("Epic /media fetch: " .. (type(media) == "table" and ("ok, logo type=" .. type(media.logo)) or "FAILED"))
    if type(media) == "table" then
        -- The /media logo is the clean transparent overlay logo; prefer it.
        local ml = media.logo
        if type(ml) == "table" then ml = ml.url or ml.src or ml.image or ml.imageUrl end
        if type(ml) == "string" and ml ~= "" then out.logo = ml end
        if type(media.images) == "table" then
            for _, im in ipairs(media.images) do
                local u = (type(im) == "table" and (im.src or im.url)) or (type(im) == "string" and im) or nil
                if u and #out.screenshots < 15 then table.insert(out.screenshots, tostring(u)) end
            end
        end
    end

    -- Some offers (e.g. the GTA V vault giveaway offer) carry NO logo at all —
    -- no *Logo keyImage and a 404 /media. Borrow a logo from a sibling offer of
    -- the same game (searched by title) that does have a ProductLogo.
    if out.logo == "" and out.title ~= "" then
        local ac = egdata_get("https://api.egdata.app/autocomplete?query=" .. url_encode(out.title))
        local function lnorm(s) return tostring(s or ""):lower():gsub("[^%w]", "") end
        local target = lnorm(out.title)
        local exact_logo, any_logo = "", ""
        for _, o in ipairs(as_array(ac)) do
            if type(o) == "table" then
                local l = pick_key_image(o.keyImages, { "DieselGameBoxLogo", "ProductLogo" })
                if l ~= "" then
                    if any_logo == "" then any_logo = l end
                    if lnorm(o.title) == target then exact_logo = l; break end
                end
            end
        end
        out.logo = (exact_logo ~= "" and exact_logo) or any_logo
        if out.logo ~= "" then
            logger:info("Epic logo fallback: borrowed sibling ProductLogo for '" .. out.title .. "'")
        end
    end

    -- Achievements live under the sandbox (namespace), grouped in sets.
    local ns = out.namespace
    if ns:match("^%x%x%x%x%x%x%x%x") then
        local sets = egdata_get("https://api.egdata.app/sandboxes/" .. ns .. "/achievements")
        if type(sets) == "table" then
            for _, set in ipairs(sets) do
                local achs = (type(set) == "table") and set.achievements or nil
                if type(achs) == "table" then
                    for _, a in ipairs(achs) do
                        if type(a) == "table" then
                            table.insert(out.achievements, {
                                name    = tostring(a.unlockedDisplayName or a.name or ""),
                                desc    = tostring(a.unlockedDescription or ""),
                                icon    = tostring(a.unlockedIconLink or a.lockedIconLink or ""),
                                xp      = tonumber(a.xp) or 0,
                                percent = tonumber(a.completedPercent) or 0,
                                hidden  = a.hidden and true or false,
                            })
                        end
                    end
                end
            end
        end
    end
    out.total_achievements = #out.achievements
    logger:info("Epic game data: '" .. out.title .. "' logo=" .. tostring(out.logo):sub(1, 70)
        .. " tall=" .. (out.tall ~= "" and "y" or "n") .. " wide=" .. (out.wide ~= "" and "y" or "n")
        .. " (" .. out.total_achievements .. " ach, " .. #out.screenshots .. " ss)")
    return cjson.encode(out)
end

function epic_friends()
    local a = epic_valid_token()
    if not a then return cjson.encode({ error = "not_logged_in" }) end

    local list_url = "https://friends-public-service-prod.ol.epicgames.com/friends/api/v1/"
        .. a.account_id .. "/friends"
    local ok, res = pcall(http.get, list_url, {
        headers = { ["Authorization"] = "Bearer " .. a.access_token, ["Accept"] = "application/json" },
        timeout = 15,
    })
    if not ok or not res or res.status ~= 200 or not res.body then
        logger:warn("Epic friends list fetch failed (status " .. tostring(res and res.status) .. ")")
        return cjson.encode({ error = "friends_failed" })
    end
    local okj, body = pcall(cjson.decode, res.body)
    if not okj then return cjson.encode({ error = "parse" }) end
    local entries = as_array(body)
    if type(body) == "table" and type(body.friends) == "table" then entries = body.friends end

    local ids = {}
    for _, fr in ipairs(entries) do
        local aid = type(fr) == "table" and (fr.accountId or fr.id) or nil
        if aid and #ids < 100 then table.insert(ids, tostring(aid)) end
    end
    if #ids == 0 then return cjson.encode({ friends = {} }) end

    -- Resolve account IDs to display names (up to 100 per request).
    local qs = {}
    for _, id in ipairs(ids) do table.insert(qs, "accountId=" .. id) end
    local names_url = "https://account-public-service-prod.ol.epicgames.com/account/api/public/account?"
        .. table.concat(qs, "&")
    local ok2, res2 = pcall(http.get, names_url, {
        headers = { ["Authorization"] = "Bearer " .. a.access_token, ["Accept"] = "application/json" },
        timeout = 15,
    })
    local names = {}
    if ok2 and res2 and res2.status == 200 and res2.body then
        local okj2, accs = pcall(cjson.decode, res2.body)
        if okj2 and type(accs) == "table" then
            for _, acc in ipairs(accs) do
                if type(acc) == "table" and acc.id then
                    names[tostring(acc.id)] = tostring(acc.displayName or acc.id)
                end
            end
        end
    end

    local friends = {}
    for _, id in ipairs(ids) do
        table.insert(friends, { id = id, name = names[id] or "Epic Player", avatar = "" })
    end
    -- Named friends first, then any that failed to resolve.
    table.sort(friends, function(x, y) return (x.name or "") < (y.name or "") end)
    logger:info("Epic friends: " .. #friends .. " resolved")
    return cjson.encode({ friends = friends })
end

-- ── News (Google News RSS) — look/feel over accuracy, per user request ──
function epic_news(game_name)
    local q = url_encode(tostring(game_name or "") .. " game")
    local url = "https://news.google.com/rss/search?q=" .. q .. "&hl=en-US&gl=US&ceid=US:en"
    local ok, res = pcall(http.get, url, {
        headers = { ["Accept"] = "application/rss+xml,text/xml,*/*", ["User-Agent"] = "Mozilla/5.0" },
        timeout = 15,
    })
    if not ok or not res or res.status ~= 200 or not res.body then
        logger:warn("Epic news fetch failed for '" .. tostring(game_name) .. "'")
        return cjson.encode({ items = {} })
    end
    local items = {}
    for block in res.body:gmatch("<item>(.-)</item>") do
        local title = block:match("<title>(.-)</title>") or ""
        local link = block:match("<link>(.-)</link>") or ""
        local pub = block:match("<pubDate>(.-)</pubDate>") or ""
        local desc = block:match("<description>(.-)</description>") or ""
        local source = block:match("<source[^>]*>(.-)</source>") or ""
        title = html_unescape(strip_html(title))
        -- Google News titles end with " - <Source>"; drop that for a clean headline
        local trimmed = title:gsub("%s+%-%s+[^%-]+$", "")
        if #trimmed > 4 then title = trimmed end
        table.insert(items, {
            title = title,
            url = link,
            date = rfc822_to_epoch(pub),
            contents = html_unescape(strip_html(desc)),
            image = "",
            feedlabel = html_unescape(source),
        })
        if #items >= 8 then break end
    end
    logger:info("Epic news: " .. #items .. " item(s) for '" .. tostring(game_name) .. "'")
    return cjson.encode({ items = items })
end

-- ── Community content (Reddit search) ──────────────────────────────────
function epic_community(game_name)
    local q = url_encode(tostring(game_name or ""))
    local url = "https://www.reddit.com/search.json?q=" .. q .. "&sort=top&t=year&limit=20&include_over_18=off"
    local ok, res = pcall(http.get, url, {
        headers = { ["Accept"] = "application/json", ["User-Agent"] = "windows:GameDataLinker:1.0 (by /u/retrotools)" },
        timeout = 15,
    })
    if not ok or not res or res.status ~= 200 or not res.body then
        logger:warn("Epic community (reddit) failed (status " .. tostring(res and res.status) .. ")")
        return cjson.encode({ items = {} })
    end
    local okj, body = pcall(cjson.decode, res.body)
    if not okj or type(body) ~= "table" or type(body.data) ~= "table" then
        return cjson.encode({ items = {} })
    end
    local items = {}
    for _, ch in ipairs(body.data.children or {}) do
        local d = type(ch) == "table" and ch.data or nil
        if type(d) == "table" then
            local img = nil
            if type(d.preview) == "table" and type(d.preview.images) == "table" and type(d.preview.images[1]) == "table" then
                local src = d.preview.images[1].source
                if type(src) == "table" and src.url then img = tostring(src.url):gsub("&amp;", "&") end
            end
            if not img and type(d.thumbnail) == "string" and d.thumbnail:match("^https?://") then img = d.thumbnail end
            if img then
                table.insert(items, {
                    type = "screenshot",
                    image = img,
                    title = html_unescape(tostring(d.title or "")),
                    author_name = "u/" .. tostring(d.author or "reddit"),
                    author_avatar = "",
                    link = "https://www.reddit.com" .. tostring(d.permalink or ""),
                })
            end
        end
        if #items >= 15 then break end
    end
    logger:info("Epic community (reddit): " .. #items .. " item(s) for '" .. tostring(game_name) .. "'")
    return cjson.encode({ items = items })
end

-- Download Epic key images into the Steam grid folder so the shortcut shows
-- the real game's artwork. Single JSON-string arg to avoid arg-order quirks.
function epic_save_artwork(payload)
    local ok, p = pcall(cjson.decode, tostring(payload or ""))
    if not ok or type(p) ~= "table" or not p.shortcut_app_id then
        return cjson.encode({ error = "bad_payload" })
    end
    local account_id = get_active_account_id()
    if not account_id then return cjson.encode({ error = "no_active_user" }) end

    local grid_dir = fs.join(millennium.steam_path(), "userdata", account_id, "config", "grid")
    if not fs.exists(grid_dir) then fs.create_directories(grid_dir) end

    local sid = tostring(p.shortcut_app_id)
    -- { url, filename suffix }  – portrait, hero, logo, wide capsule
    local images = {
        { p.tall, "p" },
        { p.hero or p.wide, "_hero" },
        { p.logo, "_logo" },
        { p.wide, "" },
    }
    local saved = 0
    for _, img in ipairs(images) do
        local url = img[1]
        if type(url) == "string" and url:match("^https?://") then
            -- Epic logos are transparent PNGs (and the URL often has no
            -- extension), so force png for the logo slot.
            local ext = (img[2] == "_logo") and "png" or (url:match("%.png") and "png" or "jpg")
            -- SteamGridDB's CDN makes Millennium's http.get return a truncated
            -- body (8 bytes for a PNG). Route it through a CORS/HTTP-friendly
            -- image proxy that re-serves the bytes so the download completes.
            local fetch_url = url
            if url:match("steamgriddb%.com") then
                fetch_url = "https://wsrv.nl/?url=" .. url:gsub("^https?://", "") .. "&output=png"
            end
            local okd, res = pcall(http.get, fetch_url, { timeout = 30 })
            -- Require a plausibly-complete image (a truncated download is only a
            -- few bytes) so we never persist a broken file that hides the logo.
            if okd and res and res.status == 200 and res.body and #res.body > 100 then
                for _, old in ipairs({ "jpg", "jpeg", "png" }) do
                    if old ~= ext then
                        local op = fs.join(grid_dir, sid .. img[2] .. "." .. old)
                        if fs.exists(op) then os.remove(op) end
                    end
                end
                local f = io.open(fs.join(grid_dir, sid .. img[2] .. "." .. ext), "wb")
                if f then f:write(res.body); f:close(); saved = saved + 1 end
            else
                logger:info("Epic artwork: skipped " .. (img[2] == "" and "grid" or img[2])
                    .. " (bytes=" .. tostring(res and res.body and #res.body) .. ")")
            end
        end
    end
    logger:info("Epic artwork saved: " .. saved .. " for shortcut " .. sid)
    return cjson.encode({ saved = saved })
end

-- ── Xbox: Microsoft OAuth → Xbox Live (XBL) → XSTS ─────────────────────
-- A well-known public Microsoft client that supports the OAuth 2.0 device
-- code flow against the consumer (live.com) endpoint. Microsoft killed the
-- old redirect/"copy the URL" desktop flow with an anti-phishing interstitial,
-- so device code is the only reliable path now: the user enters a short code
-- at microsoft.com/link and we poll for the token. All constants are literals
-- so nothing runs at module load (a load-time crash kills the whole backend).
local XBOX_CLIENT_ID  = "00000000402b5328"
local XBOX_SCOPE      = "service::user.auth.xboxlive.com::MBI_SSL"
local XBOX_DEVICE_URL = "https://login.live.com/oauth20_connect.srf"
local XBOX_TOKEN_URL  = "https://login.live.com/oauth20_token.srf"

local function get_xbox_auth_path()
    return fs.join(get_plugin_dir(), "xbox_auth.json")
end

local function read_xbox_auth()
    local path = get_xbox_auth_path()
    if not fs.exists(path) then return nil end
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    if not content or content == "" then return nil end
    local ok, data = pcall(cjson.decode, content)
    if not ok or type(data) ~= "table" then return nil end
    return data
end

local function write_xbox_auth(tbl)
    local f = io.open(get_xbox_auth_path(), "w")
    if not f then return false end
    f:write(cjson.encode(tbl))
    f:close()
    return true
end

-- POST to the Microsoft token endpoint (form-encoded); returns decoded JSON.
local function xbox_ms_token(body_params)
    local res = http_post(XBOX_TOKEN_URL, {
        ["Content-Type"] = "application/x-www-form-urlencoded",
        ["Accept"]       = "application/json",
    }, body_params)
    if not res or res.status ~= 200 or not res.body then
        logger:warn("Xbox MS token HTTP " .. tostring(res and res.status) .. ": " .. tostring(res and res.body):sub(1, 200))
        return nil
    end
    local ok, j = pcall(cjson.decode, res.body)
    if not ok or type(j) ~= "table" or not j.access_token then return nil end
    return j
end

-- Exchange a Microsoft access token for an XSTS token + user identity.
local function xbox_xsts_chain(ms_access_token)
    -- The RpsTicket prefix differs between client generations ("" for the
    -- legacy MBI_SSL client, "d="/"t=" for others) — try until one takes.
    local xbl = nil
    for _, prefix in ipairs({ "", "d=", "t=" }) do
        local payload = cjson.encode({
            RelyingParty = "http://auth.xboxlive.com",
            TokenType    = "JWT",
            Properties   = {
                AuthMethod = "RPS",
                SiteName   = "user.auth.xboxlive.com",
                RpsTicket  = prefix .. ms_access_token,
            },
        })
        local res = http_post("https://user.auth.xboxlive.com/user/authenticate", {
            ["Content-Type"] = "application/json",
            ["Accept"]       = "application/json",
            ["x-xbl-contract-version"] = "1",
        }, payload)
        if res and res.status == 200 and res.body then
            local ok, j = pcall(cjson.decode, res.body)
            if ok and type(j) == "table" and j.Token then
                logger:info("Xbox XBL auth ok (RpsTicket prefix '" .. prefix .. "')")
                xbl = j
                break
            end
        end
    end
    if not xbl then return nil, "xbl_auth_failed" end

    local payload = cjson.encode({
        RelyingParty = "http://xboxlive.com",
        TokenType    = "JWT",
        Properties   = { SandboxId = "RETAIL", UserTokens = { xbl.Token } },
    })
    local res = http_post("https://xsts.auth.xboxlive.com/xsts/authorize", {
        ["Content-Type"] = "application/json",
        ["Accept"]       = "application/json",
        ["x-xbl-contract-version"] = "1",
    }, payload)
    if not res or res.status ~= 200 or not res.body then
        logger:warn("Xbox XSTS failed (status " .. tostring(res and res.status) .. "): " .. tostring(res and res.body):sub(1, 200))
        return nil, "xsts_failed"
    end
    local ok, j = pcall(cjson.decode, res.body)
    if not ok or type(j) ~= "table" or not j.Token then return nil, "xsts_parse" end
    local xui = (type(j.DisplayClaims) == "table" and type(j.DisplayClaims.xui) == "table")
        and j.DisplayClaims.xui[1] or {}
    return {
        xsts_token = j.Token,
        uhs        = tostring(xui.uhs or ""),
        xuid       = tostring(xui.xid or ""),
        gamertag   = tostring(xui.gtg or ""),
    }
end

-- Return an auth table with a currently-valid XSTS token, refreshing the
-- Microsoft token and re-running the XBL/XSTS chain when it has aged out.
local function xbox_valid_auth()
    local a = read_xbox_auth()
    if not a then return nil end
    if a.xsts_token and a.xsts_expires_at and os.time() < (tonumber(a.xsts_expires_at) - 300) then
        return a
    end
    if not a.refresh_token then return nil end
    local j = xbox_ms_token("client_id=" .. XBOX_CLIENT_ID
        .. "&grant_type=refresh_token&refresh_token=" .. url_encode(a.refresh_token)
        .. "&scope=" .. url_encode(XBOX_SCOPE))
    if not j then logger:warn("Xbox MS token refresh failed"); return nil end
    local x = xbox_xsts_chain(j.access_token)
    if not x then return nil end
    local merged = {
        refresh_token   = j.refresh_token or a.refresh_token,
        xsts_token      = x.xsts_token,
        uhs             = x.uhs,
        xuid            = (x.xuid ~= "" and x.xuid) or a.xuid,
        gamertag        = (x.gamertag ~= "" and x.gamertag) or a.gamertag,
        xsts_expires_at = os.time() + 28800, -- XSTS lasts ~16h; refresh at 8
    }
    write_xbox_auth(merged)
    return merged
end

function xbox_status()
    local a = read_xbox_auth()
    if a and (a.xsts_token or a.refresh_token) then
        return cjson.encode({ logged_in = true, display_name = a.gamertag or "" })
    end
    return cjson.encode({ logged_in = false })
end

-- Start the device code flow: returns a short user_code the user types at
-- verification_uri (microsoft.com/link), plus a device_code the frontend polls.
function xbox_device_start()
    local body = "client_id=" .. XBOX_CLIENT_ID
        .. "&scope=" .. url_encode(XBOX_SCOPE)
        .. "&response_type=device_code"
    local res = http_post(XBOX_DEVICE_URL, {
        ["Content-Type"] = "application/x-www-form-urlencoded",
        ["Accept"]       = "application/json",
    }, body)
    if not res or res.status ~= 200 or not res.body then
        logger:warn("Xbox device start failed (status " .. tostring(res and res.status) .. ")")
        return cjson.encode({ error = "device_start_failed" })
    end
    local ok, j = pcall(cjson.decode, res.body)
    if not ok or type(j) ~= "table" or not j.device_code then
        return cjson.encode({ error = "parse" })
    end
    logger:info("Xbox device flow started (user_code " .. tostring(j.user_code) .. ")")
    return cjson.encode({
        device_code      = tostring(j.device_code),
        user_code        = tostring(j.user_code or ""),
        verification_uri = tostring(j.verification_uri or "https://www.microsoft.com/link"),
        interval         = tonumber(j.interval) or 5,
        expires_in       = tonumber(j.expires_in) or 900,
    })
end

-- Poll once for the device code result. Returns { pending = true } until the
-- user finishes signing in, then runs the XBL/XSTS chain and persists auth.
function xbox_device_poll(device_code)
    local dc = tostring(device_code or "")
    if dc == "" then return cjson.encode({ error = "bad_device_code" }) end
    local body = "client_id=" .. XBOX_CLIENT_ID
        .. "&grant_type=" .. url_encode("urn:ietf:params:oauth:grant-type:device_code")
        .. "&device_code=" .. url_encode(dc)
    local res = http_post(XBOX_TOKEN_URL, {
        ["Content-Type"] = "application/x-www-form-urlencoded",
        ["Accept"]       = "application/json",
    }, body)
    if not res or not res.body then return cjson.encode({ pending = true }) end
    local ok, j = pcall(cjson.decode, res.body)
    if not ok or type(j) ~= "table" then return cjson.encode({ pending = true }) end
    if j.error then
        local e = tostring(j.error)
        -- Still waiting for the user, or asked to back off — keep polling.
        if e == "authorization_pending" or e == "slow_down" then
            return cjson.encode({ pending = true })
        end
        logger:warn("Xbox device poll error: " .. e)
        return cjson.encode({ error = e })  -- expired_token / authorization_declined / bad_verification_code
    end
    if not j.access_token then return cjson.encode({ pending = true }) end

    local x, err = xbox_xsts_chain(j.access_token)
    if not x then return cjson.encode({ error = err or "xsts_failed" }) end
    write_xbox_auth({
        refresh_token   = j.refresh_token,
        xsts_token      = x.xsts_token,
        uhs             = x.uhs,
        xuid            = x.xuid,
        gamertag        = x.gamertag,
        xsts_expires_at = os.time() + 28800,
    })
    logger:info("Xbox account linked (device flow): " .. tostring(x.gamertag))
    return cjson.encode({ ok = true, display_name = x.gamertag })
end

function xbox_logout()
    local path = get_xbox_auth_path()
    if fs.exists(path) then os.remove(path) end
    return cjson.encode({ ok = true })
end

-- ── Xbox: game metadata / achievements / friends ───────────────────────

local function xbl_headers(a, contract)
    return {
        ["Authorization"]           = "XBL3.0 x=" .. a.uhs .. ";" .. a.xsts_token,
        ["x-xbl-contract-version"]  = tostring(contract),
        ["Accept"]                  = "application/json",
        ["Accept-Language"]         = "en-US",
    }
end

local function pick_ms_image(images, purposes)
    if type(images) ~= "table" then return "" end
    for _, want in ipairs(purposes) do
        for _, img in ipairs(images) do
            if type(img) == "table" and tostring(img.ImagePurpose) == want and img.Uri then
                local u = tostring(img.Uri)
                if u:sub(1, 2) == "//" then u = "https:" .. u end
                return u
            end
        end
    end
    return ""
end

function xbox_game_data(product_id)
    local pid = tostring(product_id or ""):gsub("[^%w]", ""):upper()
    if pid == "" then return cjson.encode({ error = "bad_product" }) end

    -- Microsoft's public display catalog — no auth needed.
    local url = "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" .. pid
        .. "&market=US&languages=en-US,neutral"
    local ok, res = pcall(http.get, url, { headers = { ["Accept"] = "application/json" }, timeout = 20 })
    if not ok or not res or res.status ~= 200 or not res.body then
        logger:warn("Xbox catalog fetch failed (status " .. tostring(res and res.status) .. ")")
        return cjson.encode({ error = "catalog_failed" })
    end
    local okj, body = pcall(cjson.decode, res.body)
    if not okj or type(body) ~= "table" or type(body.Products) ~= "table" or not body.Products[1] then
        return cjson.encode({ error = "product_not_found" })
    end
    local prod = body.Products[1]
    local lp = (type(prod.LocalizedProperties) == "table" and prod.LocalizedProperties[1]) or {}
    local mkt = (type(prod.MarketProperties) == "table" and prod.MarketProperties[1]) or {}
    local images = lp.Images

    -- The Xbox title id (used by the achievements service) hides in AlternateIds.
    local title_id = ""
    if type(prod.AlternateIds) == "table" then
        for _, alt in ipairs(prod.AlternateIds) do
            if type(alt) == "table" and tostring(alt.IdType) == "XboxTitleId" then
                title_id = tostring(alt.Value or "")
                break
            end
        end
    end

    local title = tostring(lp.ProductTitle or "")
    local slug = title:lower():gsub("[^%w]+", "-"):gsub("^%-+", ""):gsub("%-+$", "")
    local out = {
        id          = pid,
        platform    = "xbox",
        namespace   = title_id,
        title       = title,
        description = tostring(lp.ProductDescription or lp.ShortDescription or ""),
        developer   = tostring(lp.DeveloperName or ""),
        publisher   = tostring(lp.PublisherName or ""),
        release     = tostring(mkt.OriginalReleaseDate or ""),
        slug        = slug,
        store_url   = "https://www.xbox.com/en-US/games/store/" .. ((slug ~= "") and slug or "game") .. "/" .. pid,
        tall        = pick_ms_image(images, { "Poster", "BrandedKeyArt", "BoxArt" }),
        wide        = pick_ms_image(images, { "SuperHeroArt", "TitledHeroArt", "BrandedKeyArt" }),
        -- NEVER fall back to BoxArt here — a box cover looks wrong as the hero
        -- wordmark overlay. Use only the real "Logo" image; the Steam cross-ref
        -- below replaces it with a clean transparent logo when possible.
        logo        = pick_ms_image(images, { "Logo" }),
        screenshots = {},
        achievements = {},
        total_achievements = 0,
        unlocked_achievements = 0,
    }
    if type(images) == "table" then
        for _, img in ipairs(images) do
            if type(img) == "table" and tostring(img.ImagePurpose) == "Screenshot" and img.Uri and #out.screenshots < 15 then
                local u = tostring(img.Uri)
                if u:sub(1, 2) == "//" then u = "https:" .. u end
                table.insert(out.screenshots, u)
            end
        end
    end

    -- Microsoft's "Logo" image is a square icon / box art, NOT a clean
    -- transparent wordmark. Source a real logo, best first:
    --   1. SteamGridDB (universal transparent logos; needs the user's API key)
    --   2. Steam's own library logo.png (keyless, but only if the game's on Steam)
    --   3. the Microsoft "Logo" image already in out.logo (last resort)
    local steam_appid = steam_search_appid(out.title)
    local sg = sgdb_logo_url(out.title, steam_appid)
    if sg ~= "" then
        out.logo = sg
        logger:info("Xbox logo: using SteamGridDB logo for '" .. out.title .. "'")
    elseif steam_appid then
        out.logo = "https://cdn.cloudflare.steamstatic.com/steam/apps/" .. steam_appid .. "/logo.png"
        logger:info("Xbox logo: using Steam clean logo for '" .. out.title .. "' (appid " .. steam_appid .. ")")
    end

    -- Achievements ride the signed-in user's own progress (real unlocked
    -- state — better than Epic, which only exposes global rarity).
    local a = xbox_valid_auth()
    if a and title_id ~= "" and a.xuid and a.xuid ~= "" then
        local aurl = "https://achievements.xboxlive.com/users/xuid(" .. a.xuid .. ")/achievements?titleId="
            .. title_id .. "&maxItems=1000"
        local oka, ares = pcall(http.get, aurl, { headers = xbl_headers(a, 2), timeout = 20 })
        if oka and ares and ares.status == 200 and ares.body then
            local okaj, abody = pcall(cjson.decode, ares.body)
            if okaj and type(abody) == "table" and type(abody.achievements) == "table" then
                for _, ach in ipairs(abody.achievements) do
                    if type(ach) == "table" then
                        local icon = ""
                        if type(ach.mediaAssets) == "table" and type(ach.mediaAssets[1]) == "table" then
                            icon = tostring(ach.mediaAssets[1].url or "")
                        end
                        local gs = 0
                        if type(ach.rewards) == "table" then
                            for _, rw in ipairs(ach.rewards) do
                                if type(rw) == "table" and tostring(rw.type) == "Gamerscore" then
                                    gs = tonumber(rw.value) or 0
                                end
                            end
                        end
                        local unlocked = tostring(ach.progressState) == "Achieved"
                        if unlocked then out.unlocked_achievements = out.unlocked_achievements + 1 end
                        table.insert(out.achievements, {
                            name     = tostring(ach.name or ""),
                            desc     = tostring(ach.description or ach.lockedDescription or ""),
                            icon     = icon,
                            xp       = gs,
                            percent  = (type(ach.rarity) == "table" and tonumber(ach.rarity.currentPercentage)) or 0,
                            hidden   = ach.isSecret and true or false,
                            unlocked = unlocked,
                        })
                    end
                end
            end
        else
            logger:warn("Xbox achievements fetch failed (status " .. tostring(ares and ares.status) .. ")")
        end
    end
    out.total_achievements = #out.achievements
    logger:info("Xbox game data: '" .. out.title .. "' logo=" .. (out.logo ~= "" and "y" or "n")
        .. " tall=" .. (out.tall ~= "" and "y" or "n") .. " wide=" .. (out.wide ~= "" and "y" or "n")
        .. " titleId=" .. title_id .. " (" .. out.total_achievements .. " ach, "
        .. out.unlocked_achievements .. " unlocked, " .. #out.screenshots .. " ss)")
    return cjson.encode(out)
end

function xbox_friends()
    local a = xbox_valid_auth()
    if not a then return cjson.encode({ error = "not_logged_in" }) end

    -- Peoplehub gives display names AND avatar URLs. Contract version varies
    -- by deployment; try the known ones until a 200.
    local body = nil
    for _, contract in ipairs({ 3, 1, 5 }) do
        local ok, res = pcall(http.get,
            "https://peoplehub.xboxlive.com/users/me/people/social/decoration/detail",
            { headers = xbl_headers(a, contract), timeout = 20 })
        if ok and res and res.status == 200 and res.body then
            local okj, b = pcall(cjson.decode, res.body)
            if okj and type(b) == "table" and type(b.people) == "table" then body = b; break end
        else
            logger:warn("Xbox friends (contract " .. contract .. ") status " .. tostring(res and res.status))
        end
    end
    if not body then return cjson.encode({ error = "friends_failed" }) end

    local friends = {}
    for _, p in ipairs(body.people) do
        if type(p) == "table" and #friends < 100 then
            table.insert(friends, {
                id     = tostring(p.xuid or ""),
                name   = tostring(p.displayName or p.gamertag or p.modernGamertag or "Xbox Player"),
                avatar = tostring(p.displayPicRaw or ""),
            })
        end
    end
    table.sort(friends, function(x, y) return (x.name or "") < (y.name or "") end)
    logger:info("Xbox friends: " .. #friends .. " resolved")
    return cjson.encode({ friends = friends })
end

-- ── Cross-platform patch notes (Epic/Xbox → Steam news) ────────────────
-- Many Epic/Xbox games are ALSO on Steam, whose news hub carries real patch
-- notes with the native event types + cover art. Resolve the title to a Steam
-- appid (guarded so "Minecraft" can't match "Minecraft Dungeons"), then pull
-- that game's update events so they render in the native patch-notes card.

local STEAM_EDITION_WORDS = {
    enhanced = true, edition = true, definitive = true, remastered = true,
    complete = true, goty = true, deluxe = true, ultimate = true, gold = true,
    standard = true, game = true, of = true, the = true, year = true, hd = true,
    remake = true, redux = true, anniversary = true, collection = true,
    bundle = true, premium = true, legacy = true, classic = true, ["and"] = true,
}

-- Global (not local) so xbox_game_data, defined earlier in the file, can call
-- it at runtime for its clean-logo cross-reference. Memoized for the VM's
-- lifetime so the logo lookup and the patch-notes lookup for the same title
-- share ONE store search instead of two concurrent ones (less native http churn).
local steam_appid_cache = {}
function steam_search_appid(title)
    local t = tostring(title or "")
    if t == "" then return nil end
    local ckey = t:lower()
    local cached = steam_appid_cache[ckey]
    if cached ~= nil then
        if cached == false then return nil end
        return cached
    end
    local url = "https://store.steampowered.com/api/storesearch/?term=" .. url_encode(t) .. "&cc=us&l=en"
    local ok, res = pcall(http.get, url, { headers = { ["Accept"] = "application/json" }, timeout = 15 })
    if not ok or not res or res.status ~= 200 or not res.body then return nil end
    local okj, body = pcall(cjson.decode, res.body)
    if not okj or type(body) ~= "table" or type(body.items) ~= "table" then return nil end

    local function norm(s)
        return tostring(s or ""):lower():gsub("[^%w%s]", " "):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
    end
    local q = norm(title)
    if q == "" then return nil end
    for _, it in ipairs(body.items) do
        if type(it) == "table" and it.id then
            local name = norm(it.name)
            local accept = false
            if name == q then
                accept = true
            elseif name:sub(1, #q + 1) == (q .. " ") then
                -- Trailing words are only allowed if they're edition-like
                -- (Enhanced, 2026 Edition, GOTY, roman numerals) — this rejects
                -- a different game that merely starts with the same word.
                accept = true
                for w in name:sub(#q + 2):gmatch("%S+") do
                    if not (STEAM_EDITION_WORDS[w] or w:match("^%d%d%d%d$") or w:match("^[ivxlc]+$")) then
                        accept = false
                        break
                    end
                end
            end
            if accept then
                local id = tostring(it.id)
                steam_appid_cache[ckey] = id
                logger:info("Steam cross-ref: '" .. t .. "' -> appid " .. id .. " ('" .. tostring(it.name) .. "')")
                return id
            end
        end
    end
    steam_appid_cache[ckey] = false
    logger:info("Steam cross-ref: no confident match for '" .. t .. "'")
    return nil
end

-- ── SteamGridDB: universal transparent logos ───────────────────────────
-- Neither Xbox/Microsoft nor Epic reliably expose a clean transparent wordmark
-- logo. SteamGridDB does, for almost every game. Requires a free API key, which
-- the user stores via set_steamgriddb_key -> sgdb_key.txt in the plugin dir.

local function get_sgdb_key()
    local path = fs.join(get_plugin_dir(), "sgdb_key.txt")
    if not fs.exists(path) then return nil end
    local f = io.open(path, "r")
    if not f then return nil end
    local k = f:read("*a")
    f:close()
    k = tostring(k or ""):gsub("%s", "")
    if k == "" then return nil end
    return k
end

local function sgdb_get(url, key)
    local ok, res = pcall(http.get, url, {
        headers = { ["Authorization"] = "Bearer " .. key, ["Accept"] = "application/json" },
        timeout = 15,
    })
    if not ok or not res or res.status ~= 200 or not res.body then return nil end
    local okj, body = pcall(cjson.decode, res.body)
    if not okj or type(body) ~= "table" or body.success == false then return nil end
    return body.data
end

function steamgriddb_status()
    return cjson.encode({ has_key = get_sgdb_key() ~= nil })
end

function set_steamgriddb_key(key)
    local k = tostring(key or ""):gsub("%s", "")
    local path = fs.join(get_plugin_dir(), "sgdb_key.txt")
    if k == "" then
        if fs.exists(path) then os.remove(path) end
        logger:info("SteamGridDB key cleared")
        return cjson.encode({ ok = true, has_key = false })
    end
    -- Validate the key against the API before storing it (a known game search).
    local d = sgdb_get("https://www.steamgriddb.com/api/v2/search/autocomplete/portal", k)
    if d == nil then
        logger:warn("SteamGridDB key rejected (validation failed)")
        return cjson.encode({ error = "invalid_key" })
    end
    local f = io.open(path, "w")
    if not f then return cjson.encode({ error = "write_failed" }) end
    f:write(k)
    f:close()
    logger:info("SteamGridDB key set and validated")
    return cjson.encode({ ok = true, has_key = true })
end

-- Return a clean transparent logo URL from SteamGridDB for a title (using a
-- known Steam appid for an exact match when available). "" if no key or none.
-- Global so xbox_game_data (defined earlier) can call it at runtime.
function sgdb_logo_url(title, steam_appid)
    local key = get_sgdb_key()
    if not key then return "" end

    local game_id = nil
    if steam_appid and tostring(steam_appid) ~= "" then
        local d = sgdb_get("https://www.steamgriddb.com/api/v2/games/steam/" .. tostring(steam_appid), key)
        if type(d) == "table" and d.id then game_id = d.id end
    end
    if not game_id then
        local d = sgdb_get("https://www.steamgriddb.com/api/v2/search/autocomplete/"
            .. url_encode(tostring(title or "")), key)
        if type(d) == "table" and type(d[1]) == "table" and d[1].id then game_id = d[1].id end
    end
    if not game_id then return "" end

    -- Prefer static (non-animated) logos; the API returns them score-ordered.
    local logos = sgdb_get("https://www.steamgriddb.com/api/v2/logos/game/" .. tostring(game_id)
        .. "?types=static&nsfw=false&humor=false", key)
    if type(logos) == "table" and type(logos[1]) == "table" and logos[1].url then
        return tostring(logos[1].url)
    end
    return ""
end

function cross_platform_patch_notes(game_name)
    local appid = steam_search_appid(game_name)
    if not appid then return cjson.encode({ items = {} }) end

    local events = scrape_partner_events(appid, "english", 15)
    -- Keep updates / patch notes: event types 12 (update), 13/14 (major/small
    -- update), 30 (content release), plus anything whose headline reads like a
    -- patch note.
    local keep_type = { [12] = true, [13] = true, [14] = true, [30] = true }
    local items = {}
    for _, ev in ipairs(events) do
        local et = tonumber(ev.event_type) or 0
        local title_l = tostring(ev.title or ""):lower()
        local is_patch = keep_type[et]
            or title_l:match("patch") or title_l:match("update") or title_l:match("hotfix")
            or title_l:match("%f[%w]v?%d+%.%d+")  -- version-number headline
        if is_patch then
            items[#items + 1] = ev
            if #items >= 6 then break end
        end
    end
    logger:info("Cross-platform patch notes: " .. #items .. " for '" .. tostring(game_name) .. "' (appid " .. appid .. ")")
    return cjson.encode({ items = items, appid = appid })
end

-- ── Lifecycle ──────────────────────────────────────────────────────────

local function on_load()
    logger:info("Game Data Linker plugin loaded")

    -- Diagnostic logging to help debug path issues on non-standard installs
    local ok_diag, diag_err = pcall(function()
        logger:info("  Steam path: " .. tostring(millennium.steam_path()))
        logger:info("  Backend dir: " .. tostring(MILLENNIUM_PLUGIN_SECRET_BACKEND_ABSOLUTE or "(nil)"))
        local cfg = get_config_path()
        logger:info("  Config path: " .. tostring(cfg))
        logger:info("  Config exists: " .. tostring(fs.exists(cfg)))
        -- Test that we can actually read/write on this path
        local test_data = read_mappings()
        logger:info("  Mappings loaded: " .. tostring(test_data ~= nil) .. " (" .. tostring(#(cjson.encode(test_data))) .. " bytes)")
    end)
    if not ok_diag then
        logger:warn("  Diagnostic check failed: " .. tostring(diag_err))
    end

    millennium.ready()
end

local function on_unload()
    logger:info("Game Data Linker plugin unloaded")
end

local function on_frontend_loaded()
    logger:info("Frontend loaded – Game Data Linker ready")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded
}
