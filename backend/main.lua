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
        return cjson.encode({ items = {} })
    end

    local marker = 'data-initialEvents="'
    local a = res.body:find(marker, 1, true)
    if not a then
        logger:warn("Partner events: data-initialEvents not found for appid " .. appid)
        return cjson.encode({ items = {} })
    end
    local vstart = a + #marker
    local vend = res.body:find('"', vstart, true)
    if not vend then
        return cjson.encode({ items = {} })
    end

    local ok2, body = pcall(cjson.decode, html_unescape(res.body:sub(vstart, vend - 1)))
    if not ok2 or type(body) ~= "table" or type(body.events) ~= "table" then
        logger:warn("Partner events parse failed for appid " .. appid)
        return cjson.encode({ items = {} })
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
            if #items >= 10 then break end
        end
    end

    logger:info("Partner events: " .. tostring(#items) .. " item(s) for appid " .. appid)
    return cjson.encode({ items = items })
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
                logger:info("Parsed item #" .. tostring(#items) .. ": type=" .. tostring(item.type) .. " title=" .. tostring(item.title or ""):sub(1, 40) .. " author=" .. tostring(item.author_name or ""))
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
