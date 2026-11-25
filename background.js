// background.js — Service Worker (Manifest V3)

const VK_API_VERSION = "5.131";
const VK_USER_AGENT = "VKAndroidApp/5.23-2978 (Android 4.4.2; SDK 19; x86)";

// ---------- Утилиты ----------

function sanitizeFileName(name) {
  return (name || "track")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "track";
}

function parseVkAudioUrl(url) {
  const m1 = url.match(/audio(-?\d+)_(\d+)/);
  if (m1) return { ownerId: m1[1], audioId: m1[2] };
  const m2 = url.match(/music\/album\/(-?\d+)_(\d+)_([A-Za-z0-9]+)/);
  if (m2) return { ownerId: m2[1], audioId: m2[2], accessKey: m2[3] };
  return null;
}

// ---------- Токен: только из chrome.storage.local ----------

async function getStoredToken() {
  const { vkToken } = await chrome.storage.local.get("vkToken");
  return (vkToken || "").trim();
}

async function setStoredToken(token) {
  await chrome.storage.local.set({ vkToken: token.trim() });
}

async function clearStoredToken() {
  await chrome.storage.local.remove("vkToken");
}

// ---------- VK API ----------

async function vkApi(method, params, token) {
  const url = new URL(`https://api.vk.com/method/${method}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("v", VK_API_VERSION);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": VK_USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const data = await res.json();
  if (data.error) {
    // 5 — авторизация не удалась (плохой токен), 15 — доступ запрещён, 200 — доступ к audio запрещён
    const code = data.error.error_code;
    const msg = data.error.error_msg;
    if (code === 5) throw new Error(`Токен недействителен (${msg}). Смени токен.`);
    if (code === 15 || code === 200) {
      throw new Error(`Нет доступа к audio (${code}: ${msg}). Нужен токен с правами audio.`);
    }
    throw new Error(`VK API ${code}: ${msg}`);
  }
  return data.response;
}

async function validateToken(token) {
  // users.get — самый дешёвый способ проверить, живой ли токен
  const me = await vkApi("users.get", {}, token);
  if (!me || !me[0]) throw new Error("Токен недействителен");
  return { id: me[0].id, name: `${me[0].first_name} ${me[0].last_name}`.trim() };
}

async function getTrackInfo(ownerId, audioId, accessKey, token) {
  const audios = `${ownerId}_${audioId}${accessKey ? "_" + accessKey : ""}`;
  const response = await vkApi("audio.getById", { audios }, token);
  const track = Array.isArray(response) ? response[0] : response;
  if (!track) throw new Error("VK не вернул данные трека");
  return track;
}

// ---------- Скачивание ----------

async function startDownload({ track }) {
  if (!track.url) {
    throw new Error("VK не вернул ссылку на MP3 (трек недоступен или скрыт)");
  }
  if (track.url.includes(".m3u8")) {
    throw new Error(
      "VK вернул m3u8-поток вместо MP3. Прямое скачивание в mp3 невозможно без конвертации."
    );
  }

  const filename = sanitizeFileName(
    `${track.artist || "Unknown"} - ${track.title || "Track"}`
  ) + ".mp3";

  const downloadId = await chrome.downloads.download({
    url: track.url,
    filename: `vk-moosic/${filename}`,
    conflictAction: "uniquify",
    saveAs: false,
  });

  return { downloadId, filename };
}

// ---------- Сообщения от popup и content script ----------

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    try {
      switch (request.action) {
        case "getTokenStatus": {
          const token = await getStoredToken();
          if (!token) {
            sendResponse({ success: true, hasToken: false });
            break;
          }
          try {
            const user = await validateToken(token);
            sendResponse({ success: true, hasToken: true, valid: true, user });
          } catch (err) {
            // токен есть, но не работает — пусть popup покажет поле для смены
            sendResponse({ success: true, hasToken: true, valid: false, error: err.message });
          }
          break;
        }

        case "saveToken": {
          const { token } = request;
          if (!token || !token.trim()) throw new Error("Пустой токен");
          const user = await validateToken(token.trim());
          await setStoredToken(token.trim());
          sendResponse({ success: true, user });
          break;
        }

        case "clearToken": {
          await clearStoredToken();
          sendResponse({ success: true });
          break;
        }

        case "getTrackInfo": {
          const token = await getStoredToken();
          if (!token) throw new Error("Токен не задан. Вставь токен VK.");
          const { ownerId, audioId, accessKey } = request;
          const track = await getTrackInfo(ownerId, audioId, accessKey, token);
          sendResponse({
            success: true,
            track: {
              id: track.id,
              owner_id: track.owner_id,
              artist: track.artist,
              title: track.title,
              duration: track.duration,
              url: track.url,
              isM3u8: track.url ? track.url.includes(".m3u8") : true,
            },
          });
          break;
        }

        case "downloadTrack": {
          const { track } = request;
          const result = await startDownload({ track });
          sendResponse({ success: true, ...result });
          break;
        }

        // === НОВОЕ: скачивание по ID прямо со страницы VK (content.js) ===
        case "downloadByAudioId": {
          const token = await getStoredToken();
          if (!token) {
            throw new Error("Токен не задан. Открой расширение и вставь токен VK.");
          }

          const { ownerId, audioId, accessKey } = request;
          const track = await getTrackInfo(ownerId, audioId, accessKey, token);
          const result = await startDownload({ track });
          sendResponse({ success: true, ...result });
          break;
        }

        default:
          sendResponse({ success: false, error: `Неизвестное действие: ${request.action}` });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message || String(err) });
    }
  })();
  return true;
});