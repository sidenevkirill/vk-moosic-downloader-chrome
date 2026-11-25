// popup.js

const $ = (id) => document.getElementById(id);
const tokenInfo = $("tokenInfo");
const tokenWho = $("tokenWho");
const tokenGroup = $("tokenGroup");
const tokenInput = $("token");
const saveTokenBtn = $("saveTokenBtn");
const changeTokenBtn = $("changeTokenBtn");
const urlInput = $("url");
const checkBtn = $("checkBtn");
const downloadBtn = $("downloadBtn");
const statusEl = $("status");
const trackCard = $("trackCard");
const trackTitle = $("trackTitle");
const trackMeta = $("trackMeta");

let currentTrack = null;
let hasToken = false;

// ---------- Тема ----------
(async () => {
  const { theme } = await chrome.storage.local.get("theme");
  if (theme === "dark") document.body.classList.add("dark");
})();
$("theme").addEventListener("click", async () => {
  document.body.classList.toggle("dark");
  await chrome.storage.local.set({
    theme: document.body.classList.contains("dark") ? "dark" : "light",
  });
});

// ---------- Статус ----------
function showStatus(text, kind = "info") {
  statusEl.textContent = text;
  statusEl.className = kind;
}
function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "";
}

// ---------- Токен: UI ----------
function showTokenInput() {
  tokenGroup.style.display = "";
  tokenInfo.style.display = "none";
  tokenInput.value = "";
  tokenInput.focus();
}

function showTokenSaved(user, isValid = true) {
  tokenGroup.style.display = "none";
  tokenInfo.style.display = "";
  tokenInfo.className = "token-line " + (isValid ? "ok" : "bad");
  if (isValid) {
    tokenWho.innerHTML = `Пользователь: <b>${escapeHtml(user.name)}</b> (id ${user.id})`;
  } else {
    tokenWho.innerHTML = `⚠ Токен сохранён, но не работает`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Инициализация ----------
(async () => {
  const { lastUrl } = await chrome.storage.local.get("lastUrl");
  if (lastUrl) urlInput.value = lastUrl;

  try {
    const resp = await chrome.runtime.sendMessage({ action: "getTokenStatus" });
    if (!resp?.success) throw new Error(resp?.error || "неизвестно");

    if (resp.hasToken && resp.valid) {
      hasToken = true;
      showTokenSaved(resp.user, true);
    } else if (resp.hasToken && !resp.valid) {
      hasToken = false;
      showTokenSaved(null, false);
      // показываем поле, чтобы можно было сразу заменить
      tokenGroup.style.display = "";
      showStatus("Сохранённый токен не работает: " + (resp.error || ""), "err");
    } else {
      hasToken = false;
      showTokenInput();
    }
  } catch (err) {
    showTokenInput();
    showStatus("Не удалось проверить токен: " + err.message, "err");
  }
})();

// ---------- Смена токена ----------
changeTokenBtn.addEventListener("click", () => {
  clearStatus();
  showTokenInput();
});

// ---------- Сохранение токена ----------
saveTokenBtn.addEventListener("click", async () => {
  clearStatus();
  const token = tokenInput.value.trim();
  if (!token) {
    showStatus("Вставь токен.", "err");
    return;
  }

  saveTokenBtn.disabled = true;
  showStatus("Проверяю токен через users.get…", "info");

  try {
    const resp = await chrome.runtime.sendMessage({ action: "saveToken", token });
    if (!resp?.success) {
      showStatus("Ошибка: " + (resp?.error || "неизвестно"), "err");
      return;
    }
    hasToken = true;
    showTokenSaved(resp.user, true);
    showStatus(`✓ Токен сохранён. Аккаунт: ${resp.user.name}`, "ok");
  } catch (err) {
    showStatus("Ошибка: " + err.message, "err");
  } finally {
    saveTokenBtn.disabled = false;
  }
});

// ---------- Парсинг ссылки ----------
function parseVkAudioUrl(url) {
  if (!url) return null;
  const m1 = url.match(/audio(-?\d+)_(\d+)/);
  if (m1) return { ownerId: m1[1], audioId: m1[2] };
  const m2 = url.match(/music\/album\/(-?\d+)_(\d+)_([A-Za-z0-9]+)/);
  if (m2) return { ownerId: m2[1], audioId: m2[2], accessKey: m2[3] };
  return null;
}

function validateInputs({ needTrack = false } = {}) {
  if (!hasToken) {
    showStatus("Сначала сохрани токен VK.", "err");
    return null;
  }
  const url = urlInput.value.trim();
  if (!url) {
    showStatus("Вставь ссылку на трек.", "err");
    return null;
  }
  const parsed = parseVkAudioUrl(url);
  if (!parsed) {
    showStatus(
      "Не удалось распознать ссылку. Поддерживается .../audio-123_456 или .../music/album/...",
      "err"
    );
    return null;
  }
  if (needTrack && !currentTrack) {
    showStatus("Сначала нажми «Проверить», чтобы получить трек.", "err");
    return null;
  }
  return { url, ...parsed };
}

// ---------- Проверить ----------
checkBtn.addEventListener("click", async () => {
  clearStatus();
  currentTrack = null;
  trackCard.classList.remove("show");
  downloadBtn.disabled = true;

  const data = validateInputs();
  if (!data) return;

  await chrome.storage.local.set({ lastUrl: data.url });

  checkBtn.disabled = true;
  showStatus("Запрашиваю трек у VK…", "info");

  try {
    const resp = await chrome.runtime.sendMessage({
      action: "getTrackInfo",
      ownerId: data.ownerId,
      audioId: data.audioId,
      accessKey: data.accessKey,
    });

    if (!resp?.success) {
      // если токен вдруг протух — предложим сменить
      if ((resp?.error || "").includes("Токен недействителен")) {
        hasToken = false;
        showTokenInput();
      }
      showStatus("Ошибка: " + (resp?.error || "неизвестно"), "err");
      return;
    }

    currentTrack = resp.track;

    trackTitle.textContent = `${resp.track.artist || "Unknown"} — ${resp.track.title || "Track"}`;
    const dur = resp.track.duration
      ? `${Math.floor(resp.track.duration / 60)}:${String(resp.track.duration % 60).padStart(2, "0")}`
      : "—";
    const m3u8Badge = resp.track.isM3u8
      ? ' <span class="badge bad">m3u8 — скачать нельзя</span>'
      : ' <span class="badge">mp3 готов</span>';
    trackMeta.innerHTML = `ID: ${resp.track.id} · ${dur}${m3u8Badge}`;
    trackCard.classList.add("show");

    if (resp.track.isM3u8) {
      showStatus(
        "VK вернул m3u8-поток. Прямое скачивание в mp3 невозможно без конвертации.",
        "err"
      );
      downloadBtn.disabled = true;
    } else {
      showStatus("Трек получен. Можно скачивать.", "ok");
      downloadBtn.disabled = false;
    }
  } catch (err) {
    showStatus("Ошибка: " + err.message, "err");
  } finally {
    checkBtn.disabled = false;
  }
});

// ---------- Скачать ----------
downloadBtn.addEventListener("click", async () => {
  clearStatus();
  const data = validateInputs({ needTrack: true });
  if (!data) return;

  downloadBtn.disabled = true;
  showStatus("Запускаю скачивание…", "info");

  try {
    const resp = await chrome.runtime.sendMessage({
      action: "downloadTrack",
      track: currentTrack,
    });

    if (!resp?.success) {
      showStatus("Ошибка: " + (resp?.error || "неизвестно"), "err");
      downloadBtn.disabled = false;
      return;
    }

    showStatus(
      `✓ Скачивание начато: ${resp.filename}\nФайл появится в «Загрузки/vk-moosic/».`,
      "ok"
    );
  } catch (err) {
    showStatus("Ошибка: " + err.message, "err");
    downloadBtn.disabled = false;
  }
});