import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const CONFIG_PATH = resolve(ROOT_DIR, "config", "players.json");
const CONFIG_JS_PATH = resolve(ROOT_DIR, "config", "players-data.js");
const OUTPUT_PATH = resolve(ROOT_DIR, "data", "server.json");
const OUTPUT_JS_PATH = resolve(ROOT_DIR, "data", "server-data.js");
const SERVER_API_URL =
  process.env.FIVEM_SERVER_API_URL ||
  "https://servers-frontend.fivem.net/api/servers/single/okz5dj";
const REQUEST_TIMEOUT_MS = Number(process.env.FIVEM_REQUEST_TIMEOUT_MS) || 20000;

async function main() {
  const { config, trackedDiscordIds } = await loadConfig();
  const server = await fetchFiveMServer();
  const payload = {
    updatedAt: new Date().toISOString(),
    source: SERVER_API_URL,
    trackedPlayers: trackedDiscordIds.size,
    server: sanitizeServer(server, trackedDiscordIds),
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await mkdir(dirname(CONFIG_JS_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_JS_PATH, buildGlobalDataScript("__FIVEM_SERVER_DATA__", payload), "utf8");
  await writeFile(CONFIG_JS_PATH, buildGlobalDataScript("__PLAYERS_CONFIG__", config), "utf8");

  console.log(
    `Updated ${OUTPUT_PATH} and ${OUTPUT_JS_PATH} with ${payload.server.Data.players.length} tracked online players.`,
  );
}

async function loadConfig() {
  const text = await readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(quoteLongJsonNumbers(text));
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const ids = new Set();

  groups.forEach((group) => {
    const players = Array.isArray(group?.players) ? group.players : [];

    players.forEach((player) => {
      const discordId =
        typeof player === "object" && player !== null ? player.discordId : player;
      const normalized = normalizeDiscordId(discordId);

      if (normalized) {
        ids.add(normalized);
      }
    });
  });

  return {
    config,
    trackedDiscordIds: ids,
  };
}

async function fetchFiveMServer() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(SERVER_API_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FiveM Online Hunter data updater",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`FiveM API HTTP ${response.status}`);
    }

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`FiveM API returned invalid JSON: ${text.slice(0, 80)}`);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`FiveM API timed out after ${REQUEST_TIMEOUT_MS} ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function sanitizeServer(server, trackedDiscordIds) {
  const data = server?.Data;

  if (!data || !Array.isArray(data.players)) {
    throw new Error("FiveM API response does not contain Data.players");
  }

  const players = data.players
    .map(sanitizePlayer)
    .filter(Boolean)
    .filter((player) => trackedDiscordIds.has(getIdentifierValue(player, "discord")));

  return {
    EndPoint: String(server.EndPoint || ""),
    Data: {
      hostname: String(data.hostname || ""),
      clients: normalizeNumber(data.clients),
      sv_maxclients: normalizeNumber(data.sv_maxclients),
      svMaxclients: normalizeNumber(data.svMaxclients),
      players,
    },
  };
}

function sanitizePlayer(player) {
  const identifiers = Array.isArray(player?.identifiers)
    ? player.identifiers.map(String).filter(isNeededIdentifier)
    : [];

  if (!getIdentifierValue({ identifiers }, "discord")) {
    return null;
  }

  return {
    id: normalizeNumber(player.id),
    name: String(player.name || ""),
    ping: normalizeNumber(player.ping),
    identifiers,
  };
}

function isNeededIdentifier(identifier) {
  return identifier.startsWith("discord:") || identifier.startsWith("steam:");
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

function normalizeNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function quoteLongJsonNumbers(text) {
  return text.replace(/(^|[^"\\\w])(\d{15,25})(?=\s*[,}\]])/g, '$1"$2"');
}

function buildGlobalDataScript(name, value) {
  const json = JSON.stringify(value, null, 2)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return [
    "/* Auto-generated by scripts/update-server-data.mjs. */",
    `(function () {`,
    `  window.${name} = ${json};`,
    `}());`,
    "",
  ].join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
