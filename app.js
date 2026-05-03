const SERVER_API_URL = "https://servers-frontend.fivem.net/api/servers/single/okz5dj";
const SERVER_DATA_URL = "data/server.json";
const CONFIG_URL = "config/players.json";
const DEFAULT_REFRESH_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 12000;
const CACHE_STALE_WARNING_MS = 15 * 60 * 1000;
const DEFAULT_WEBHOOK_USERNAME = "INTOUCH TEROR";
const IS_FILE_PROTOCOL = window.location.protocol === "file:";
const EMBEDDED_SERVER_SOURCE = {
  label: "Wbudowana kopia danych",
  cached: true,
  getPayload: () => window.__FIVEM_SERVER_DATA__,
  normalize: normalizeCachedServerResponse,
};
const JSON_SERVER_SOURCE = {
  label: "data/server.json",
  cached: true,
  url: SERVER_DATA_URL,
  normalize: normalizeCachedServerResponse,
};
const SERVER_API_SOURCES = [
  ...(IS_FILE_PROTOCOL ? [EMBEDDED_SERVER_SOURCE, JSON_SERVER_SOURCE] : [JSON_SERVER_SOURCE, EMBEDDED_SERVER_SOURCE]),
  {
    label: "FiveM API",
    url: SERVER_API_URL,
    normalize: normalizeLiveServerResponse,
  },
  {
    label: "AllOrigins CORS proxy",
    url: `https://api.allorigins.win/raw?url=${encodeURIComponent(SERVER_API_URL)}`,
    normalize: normalizeLiveServerResponse,
  },
  {
    label: "Codetabs CORS proxy",
    url: `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(SERVER_API_URL)}`,
    normalize: normalizeLiveServerResponse,
  },
];

const state = {
  config: null,
  server: null,
  rows: [],
  search: "",
  showHidden: false,
  showOffline: false,
  columnCount: 0,
  refreshTimer: null,
  countdownTimer: null,
  nextRefreshAt: 0,
  webhookBaselineReady: false,
  previousPlayerStates: new Map(),
  collapsedGroups: new Set(),
  dataSource: "",
  dataUpdatedAt: "",
};

const elements = {
  serverName: document.querySelector("#serverName"),
  serverPlayers: document.querySelector("#serverPlayers"),
  lastUpdated: document.querySelector("#lastUpdated"),
  onlineCount: document.querySelector("#onlineCount"),
  offlineCount: document.querySelector("#offlineCount"),
  trackedCount: document.querySelector("#trackedCount"),
  searchInput: document.querySelector("#searchInput"),
  showHiddenToggle: document.querySelector("#showHiddenToggle"),
  showOfflineToggle: document.querySelector("#showOfflineToggle"),
  refreshButton: document.querySelector("#refreshButton"),
  refreshCountdown: document.querySelector("#refreshCountdown"),
  statusMessage: document.querySelector("#statusMessage"),
  groupsContainer: document.querySelector("#groupsContainer"),
  groupTemplate: document.querySelector("#groupTemplate"),
  playerTemplate: document.querySelector("#playerTemplate"),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await loadConfig();
  await refreshServerData();
  scheduleRefresh();
}

function bindEvents() {
  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    render();
  });

  elements.showHiddenToggle.addEventListener("change", (event) => {
    state.showHidden = event.target.checked;
    render();
  });

  elements.showOfflineToggle.addEventListener("change", (event) => {
    state.showOffline = event.target.checked;
    render();
  });

  elements.refreshButton.addEventListener("click", async () => {
    await refreshServerData();
    scheduleRefresh();
  });

  window.addEventListener("resize", () => {
    const nextColumnCount = getMasonryColumnCount();

    if (nextColumnCount !== state.columnCount) {
      render();
    }
  });
}

async function loadConfig() {
  try {
    if (IS_FILE_PROTOCOL && window.__PLAYERS_CONFIG__) {
      state.config = normalizeConfig(window.__PLAYERS_CONFIG__);
      return;
    }

    const configText = await fetchText(CONFIG_URL);
    const config = parseConfigText(configText);
    state.config = normalizeConfig(config);
  } catch (error) {
    if (window.__PLAYERS_CONFIG__) {
      state.config = normalizeConfig(window.__PLAYERS_CONFIG__);
      return;
    }

    state.config = normalizeConfig({ groups: [] });
    showMessage(`Nie udało się wczytać konfiguracji ${CONFIG_URL}: ${error.message}`, true);
  }
}

async function refreshServerData() {
  setLoading(true);

  try {
    const { server, source, updatedAt, cached } = await fetchServerData();
    state.server = server;
    state.dataSource = source;
    state.dataUpdatedAt = updatedAt;
    const rows = buildRows(state.config, server);
    await processWebhookNotifications(rows);
    state.rows = rows;
    updateServerMeta(server, updatedAt);
    const cacheWarning = buildCacheWarning(cached, updatedAt);

    if (cacheWarning) {
      showMessage(cacheWarning);
    } else {
      hideMessage();
    }

    render();
  } catch (error) {
    state.server = null;
    state.dataSource = "";
    state.dataUpdatedAt = "";
    state.rows = buildRows(state.config, null);
    updateServerMeta(null);
    showMessage(buildFetchError(error), true);
    render();
  } finally {
    setLoading(false);
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`nieprawidłowy JSON (${formatResponsePreview(text)})`);
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`przekroczono limit czasu ${REQUEST_TIMEOUT_MS / 1000}s`);
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function formatResponsePreview(text) {
  const preview = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return preview ? `odpowiedź zaczyna się od "${preview}"` : "pusta odpowiedź";
}

function parseConfigText(text) {
  return JSON.parse(quoteLongJsonNumbers(text));
}

function quoteLongJsonNumbers(text) {
  return text.replace(/(^|[^"\\\w])(\d{15,25})(?=\s*[,}\]])/g, '$1"$2"');
}

async function fetchServerData() {
  const errors = [];

  for (const source of SERVER_API_SOURCES) {
    try {
      const payload = await readServerSource(source);
      const { server, updatedAt } = source.normalize(payload);

      if (!Array.isArray(server?.Data?.players)) {
        throw new Error("brak pola Data.players");
      }

      return {
        server,
        source: source.label,
        updatedAt: updatedAt || new Date().toISOString(),
        cached: Boolean(source.cached),
      };
    } catch (error) {
      errors.push(`${source.label}: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

async function readServerSource(source) {
  if (source.getPayload) {
    const payload = source.getPayload();

    if (!payload) {
      throw new Error("brak załadowanego pliku data/server-data.js");
    }

    return payload;
  }

  return fetchJson(source.url);
}

function normalizeCachedServerResponse(payload) {
  if (!payload?.server) {
    throw new Error("brak pola server");
  }

  return {
    server: payload.server,
    updatedAt: payload.updatedAt || "",
  };
}

function normalizeLiveServerResponse(payload) {
  return {
    server: payload,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeConfig(config) {
  const groups = Array.isArray(config.groups) ? config.groups : [];

  return {
    refreshIntervalSeconds: Number(config.refreshIntervalSeconds) || DEFAULT_REFRESH_SECONDS,
    groups: groups.map((group) => ({
      name: String(group.name || "Bez nazwy"),
      hidden: normalizeBoolean(group.hidden),
      webhook: normalizeWebhook(group, config),
      players: Array.isArray(group.players)
        ? group.players
            .map(normalizeTrackedPlayer)
            .filter((player) => player.discordId)
        : [],
    })),
  };
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  return String(value || "").trim().toLowerCase() === "true";
}

function normalizeWebhook(group, config) {
  const webhook = typeof group.webhook === "object" && group.webhook !== null ? group.webhook : {};
  const rawUrl = typeof group.webhook === "string" ? group.webhook : group.webhookUrl || webhook.url;

  return {
    url: String(rawUrl || "").trim(),
    username: String(group.webhookUsername || webhook.username || config.webhookUsername || DEFAULT_WEBHOOK_USERNAME).trim(),
    threadName: String(group.webhookThreadName || group.threadName || webhook.threadName || "").trim(),
  };
}

function normalizeTrackedPlayer(player) {
  if (typeof player === "string" || typeof player === "number") {
    return {
      label: "",
      discordId: normalizeDiscordId(player),
    };
  }

  return {
    label: String(player?.label || "").trim(),
    discordId: normalizeDiscordId(player?.discordId),
  };
}

function buildRows(config, server) {
  const players = Array.isArray(server?.Data?.players) ? server.Data.players : [];
  const playersByDiscord = new Map();

  players.forEach((player) => {
    const discordId = getIdentifierValue(player, "discord");
    if (discordId && !playersByDiscord.has(discordId)) {
      playersByDiscord.set(discordId, player);
    }
  });

  return config.groups.map((group) => {
    const trackedPlayers = group.players.map((trackedPlayer) => {
      const livePlayer = playersByDiscord.get(trackedPlayer.discordId);
      const isOnline = Boolean(livePlayer);

      return {
        groupName: group.name,
        webhook: group.webhook,
        label: trackedPlayer.label,
        discordId: trackedPlayer.discordId,
        isOnline,
        id: isOnline ? livePlayer.id : "-",
        name: isOnline ? livePlayer.name : trackedPlayer.label || trackedPlayer.discordId,
        steamHex: isOnline ? getIdentifierValue(livePlayer, "steam") || "-" : "-",
        ping: isOnline ? livePlayer.ping : "-",
      };
    });

    return {
      name: group.name,
      hidden: group.hidden,
      webhook: group.webhook,
      players: trackedPlayers,
      online: trackedPlayers.filter((player) => player.isOnline).length,
      offline: trackedPlayers.filter((player) => !player.isOnline).length,
    };
  });
}

async function processWebhookNotifications(rows) {
  const currentStates = createPlayerStateMap(rows);

  if (!state.webhookBaselineReady) {
    state.previousPlayerStates = currentStates;
    state.webhookBaselineReady = true;
    return;
  }

  const notifications = [];

  currentStates.forEach((currentPlayer, key) => {
    const previousPlayer = state.previousPlayerStates.get(key);

    if (currentPlayer.isOnline && !previousPlayer?.isOnline) {
      notifications.push(sendWebhookNotification("join", currentPlayer));
      return;
    }

    if (!currentPlayer.isOnline && previousPlayer?.isOnline) {
      notifications.push(sendWebhookNotification("leave", {
        ...previousPlayer,
        groupName: currentPlayer.groupName,
        webhook: currentPlayer.webhook,
      }));
    }
  });

  if (notifications.length) {
    const results = await Promise.allSettled(notifications);
    const rejected = results.filter((result) => result.status === "rejected");

    rejected.forEach((result) => {
      console.warn("Webhook notification failed:", result.reason);
    });
  }

  state.previousPlayerStates = currentStates;
}

function createPlayerStateMap(rows) {
  const states = new Map();

  rows.forEach((group) => {
    group.players.forEach((player) => {
      states.set(getPlayerStateKey(player), {
        groupName: group.name,
        webhook: group.webhook,
        discordId: player.discordId,
        isOnline: player.isOnline,
        id: player.id,
        name: player.name,
        steamHex: player.steamHex,
      });
    });
  });

  return states;
}

function getPlayerStateKey(player) {
  return `${player.groupName}::${player.discordId}`;
}

async function sendWebhookNotification(type, player) {
  const webhookUrl = player.webhook?.url;

  if (!webhookUrl) {
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildWebhookPayload(type, player)),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook HTTP ${response.status}`);
  }
}

function buildWebhookPayload(type, player) {
  const isJoin = type === "join";
  const displayName = formatWebhookValue(player.name || player.discordId);
  const payload = {
    content: null,
    embeds: [
      {
        title: isJoin
          ? `:calling: | ${displayName} DOŁĄCZYŁ NA SERWER`
          : `:mobile_phone_off: | ${displayName} WYSZEDŁ Z SERWERA`,
        description: isJoin ? buildJoinDescription(player) : buildLeaveDescription(player),
        color: isJoin ? 3862528 : 15728640,
        author: {
          name: player.groupName,
        },
        timestamp: new Date().toISOString(),
      },
    ],
    username: player.webhook?.username || DEFAULT_WEBHOOK_USERNAME,
    attachments: [],
  };

  if (player.webhook?.threadName) {
    payload.thread_name = player.webhook.threadName;
  }

  return payload;
}

function buildJoinDescription(player) {
  return [
    `:bust_in_silhouette: NAZWA: \`\`${formatWebhookValue(player.name)}\`\``,
    `:id: ID: \`\`${formatWebhookValue(player.id)}\`\``,
    `:regional_indicator_d: DISCORDID: \`\`${formatWebhookValue(player.discordId)}\`\``,
    `:regional_indicator_s:  STEAMHEX: \`\`${formatWebhookValue(player.steamHex)}\`\``,
  ].join("\n");
}

function buildLeaveDescription(player) {
  return [
    `:id: ID: \`\`${formatWebhookValue(player.id)}\`\``,
    `:regional_indicator_d: DISCORDID: \`\`${formatWebhookValue(player.discordId)}\`\``,
  ].join("\n");
}

function formatWebhookValue(value) {
  return String(value || "-").replace(/`/g, "ˋ");
}

function render() {
  const visibleRows = state.rows.filter((group) => state.showHidden || !group.hidden);
  const filteredGroups = filterGroups(visibleRows, state.search, state.showOffline);
  const allPlayers = visibleRows.flatMap((group) => group.players);

  elements.onlineCount.textContent = String(allPlayers.filter((player) => player.isOnline).length);
  elements.offlineCount.textContent = String(allPlayers.filter((player) => !player.isOnline).length);
  elements.trackedCount.textContent = String(allPlayers.length);

  elements.groupsContainer.replaceChildren();

  if (!filteredGroups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-results";
    empty.textContent = state.search
      ? "Brak wyników dla aktualnego wyszukiwania."
      : state.showHidden
        ? "Brak grup w konfiguracji."
        : "Brak widocznych grup. Włącz Pokaż ukryte albo zmień hidden w config/players.json.";
    elements.groupsContainer.append(empty);
    return;
  }

  elements.groupsContainer.append(...createMasonryColumns(filteredGroups));
}

function createMasonryColumns(groups) {
  const columnCount = Math.min(getMasonryColumnCount(), Math.max(groups.length, 1));
  const columns = Array.from({ length: columnCount }, () => ({
    weight: 0,
    element: document.createElement("div"),
  }));

  state.columnCount = columnCount;

  columns.forEach((column) => {
    column.element.className = "masonry-column";
  });

  groups.forEach((group) => {
    const targetColumn = columns.reduce((shortest, column) => {
      return column.weight < shortest.weight ? column : shortest;
    }, columns[0]);

    targetColumn.element.append(renderGroup(group));
    targetColumn.weight += estimateGroupWeight(group);
  });

  return columns.map((column) => column.element);
}

function getMasonryColumnCount() {
  if (window.innerWidth <= 620) {
    return 1;
  }

  if (window.innerWidth <= 1180) {
    return 2;
  }

  return 3;
}

function estimateGroupWeight(group) {
  return Math.max(1, group.players.length) + 1.25;
}

function renderGroup(group) {
  const fragment = elements.groupTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".group-card");
  const button = fragment.querySelector(".group-head");
  const title = fragment.querySelector(".group-title");
  const subtitle = fragment.querySelector(".group-subtitle");
  const list = fragment.querySelector(".players-list");
  const groupKey = group.name;
  const isOpen = !state.collapsedGroups.has(groupKey);

  card.classList.toggle("is-open", isOpen);
  card.classList.toggle("is-empty", group.players.length === 0);
  card.classList.toggle("is-hidden-group", group.hidden);
  button.setAttribute("aria-expanded", String(isOpen));
  title.textContent = group.name;
  subtitle.textContent = [
    group.hidden ? "ukryta" : "",
    `${group.online} online / ${group.offline} offline / ${group.players.length} razem`,
  ]
    .filter(Boolean)
    .join(" • ");

  button.addEventListener("click", () => {
    if (state.collapsedGroups.has(groupKey)) {
      state.collapsedGroups.delete(groupKey);
    } else {
      state.collapsedGroups.add(groupKey);
    }

    render();
  });

  const displayPlayers = getDisplayPlayers(group.players);

  if (!group.players.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Brak osób w tej grupie. Dodaj je w config/players.json.";
    list.append(empty);
  } else if (!displayPlayers.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Brak osób online. Włącz Pokaż offline, żeby zobaczyć resztę.";
    list.append(empty);
  } else {
    sortPlayersForGroup(displayPlayers).forEach((player) => {
      list.append(renderPlayer(player));
    });
  }

  return fragment;
}

function getDisplayPlayers(players) {
  return state.showOffline ? players : players.filter((player) => player.isOnline);
}

function sortPlayersForGroup(players) {
  return [...players].sort((first, second) => {
    if (first.isOnline !== second.isOnline) {
      return first.isOnline ? -1 : 1;
    }

    return String(first.name || first.discordId).localeCompare(String(second.name || second.discordId), "pl");
  });
}

function renderPlayer(player) {
  const fragment = elements.playerTemplate.content.cloneNode(true);
  const row = fragment.querySelector(".player-row");

  row.classList.toggle("is-online", player.isOnline);
  row.classList.toggle("is-offline", !player.isOnline);
  fragment.querySelector(".player-name").textContent = player.name || player.discordId;
  fragment.querySelector(".player-discord").textContent = `discord:${player.discordId}`;
  fragment.querySelector(".player-status-label").textContent = player.isOnline ? "Online" : "Offline";
  fragment.querySelector(".player-id").textContent = String(player.id);
  fragment.querySelector(".player-steam").textContent = player.steamHex;
  fragment.querySelector(".player-ping").textContent = player.ping === "-" ? "-" : `${player.ping} ms`;

  return fragment;
}

function filterGroups(groups, query, includeOffline) {
  if (!query) {
    return groups;
  }

  return groups
    .map((group) => {
      const groupMatches = group.name.toLowerCase().includes(query);
      const searchablePlayers = includeOffline ? group.players : group.players.filter((player) => player.isOnline);
      const players = searchablePlayers.filter((player) => {
        return [
          group.name,
          player.label,
          player.name,
          player.discordId,
          player.steamHex,
          String(player.id),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);
      });

      if (groupMatches) {
        return group;
      }

      return {
        ...group,
        players,
        online: players.filter((player) => player.isOnline).length,
        offline: players.filter((player) => !player.isOnline).length,
      };
    })
    .filter((group) => group.name.toLowerCase().includes(query) || group.players.length > 0);
}

function updateServerMeta(server, updatedAt = "") {
  const data = server?.Data;

  if (!data) {
    elements.serverName.textContent = "Brak danych";
    elements.serverPlayers.textContent = "-";
    elements.lastUpdated.textContent = "-";
    return;
  }

  elements.serverName.textContent = data.hostname || "Brak danych";
  elements.serverPlayers.textContent = `${data.clients ?? "-"} / ${data.sv_maxclients ?? data.svMaxclients ?? "-"}`;
  elements.lastUpdated.textContent = formatUpdatedAt(updatedAt);
}

function formatUpdatedAt(updatedAt) {
  const date = updatedAt ? new Date(updatedAt) : new Date();

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const options = sameDay
    ? {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }
    : {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      };

  return new Intl.DateTimeFormat("pl-PL", options).format(date);
}

function buildCacheWarning(cached, updatedAt) {
  if (!cached || !updatedAt) {
    return "";
  }

  const updatedTime = new Date(updatedAt).getTime();

  if (!Number.isFinite(updatedTime)) {
    return "";
  }

  const ageMs = Date.now() - updatedTime;

  if (ageMs < CACHE_STALE_WARNING_MS) {
    return "";
  }

  return `Dane z data/server.json mają ${formatAge(ageMs)}. Sprawdź, czy workflow "Update FiveM server data" działa na GitHubie.`;
}

function formatAge(ageMs) {
  const minutes = Math.max(1, Math.round(ageMs / 60000));

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;

  return restMinutes ? `${hours} godz. ${restMinutes} min` : `${hours} godz.`;
}

function getIdentifierValue(player, type) {
  const prefix = `${type}:`;
  const identifiers = Array.isArray(player?.identifiers) ? player.identifiers : [];
  const match = identifiers.find((identifier) => String(identifier).startsWith(prefix));
  return match ? String(match).slice(prefix.length) : "";
}

function normalizeDiscordId(value) {
  return String(value || "")
    .trim()
    .replace(/^discord:/i, "")
    .replace(/[^\d]/g, "");
}

function scheduleRefresh() {
  window.clearTimeout(state.refreshTimer);
  window.clearInterval(state.countdownTimer);
  const seconds = Math.max(15, Number(state.config?.refreshIntervalSeconds) || DEFAULT_REFRESH_SECONDS);
  state.nextRefreshAt = Date.now() + seconds * 1000;
  updateRefreshCountdown();

  state.countdownTimer = window.setInterval(updateRefreshCountdown, 1000);
  state.refreshTimer = window.setTimeout(async () => {
    await refreshServerData();
    scheduleRefresh();
  }, seconds * 1000);
}

function updateRefreshCountdown() {
  const secondsLeft = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  elements.refreshCountdown.textContent = `Auto: ${secondsLeft}s`;
}

function setLoading(isLoading) {
  elements.refreshButton.classList.toggle("is-loading", isLoading);
  elements.refreshButton.disabled = isLoading;
}

function showMessage(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.classList.toggle("is-error", isError);
  elements.statusMessage.classList.remove("is-hidden");
}

function hideMessage() {
  elements.statusMessage.textContent = "";
  elements.statusMessage.classList.add("is-hidden");
  elements.statusMessage.classList.remove("is-error");
}

function buildFetchError(error) {
  return [
    "Nie udało się pobrać danych z FiveM.",
    "Na GitHub Pages głównym źródłem jest data/server.json odświeżany przez GitHub Actions.",
    "Jeśli plik jeszcze nie istnieje, uruchom workflow \"Update FiveM server data\" ręcznie albo poczekaj na harmonogram.",
    `Szczegóły: ${error.message}`,
  ].join(" ");
}
