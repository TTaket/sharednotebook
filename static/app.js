(() => {
  const joinForm = document.getElementById("join-form");
  const roomIdInput = document.getElementById("room-id");
  const passwordInput = document.getElementById("room-password");
  const modeSelect = document.getElementById("room-mode");
  const durationWrapper = document.getElementById("duration-wrapper");
  const durationInput = document.getElementById("room-duration");
  const joinError = document.getElementById("join-error");
  const joinCard = document.getElementById("join-card");

  const editorCard = document.getElementById("editor-card");
  const noteArea = document.getElementById("note-area");
  const editorArea = document.getElementById("editor-area");
  const cursorOverlay = document.getElementById("cursor-overlay");
  const caretMirror = document.getElementById("caret-mirror");
  const currentRoomEl = document.getElementById("current-room");
  const modeInfoEl = document.getElementById("mode-info");
  const statusEl = document.getElementById("connection-status");
  const noticeEl = document.getElementById("room-notice");

  const clientId = ensureClientId();
  const remoteCursors = new Map();
  const cursorElements = new Map();
  const cursorPalette = [
    "#ff5252",
    "#ff9800",
    "#4caf50",
    "#2196f3",
    "#9c27b0",
    "#ffc107",
    "#00bcd4",
    "#8bc34a",
    "#795548",
  ];
  const cursorColors = new Map();

  const CURSOR_THROTTLE_MS = 80;

  let countdownTimer = null;
  let expiresAt = null;
  let socket = null;
  let currentRoomId = "";
  let currentPassword = "";
  let sendTimer = null;
  let cursorTimer = null;
  let serverContent = "";
  let lastCursorSent = { start: -1, end: -1 };

  modeSelect.addEventListener("change", () => {
    const isCountdown = modeSelect.value === "countdown";
    durationWrapper.classList.toggle("hidden", !isCountdown);
  });

  joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    joinError.textContent = "";

    const roomId = roomIdInput.value.trim();
    const password = passwordInput.value.trim();
    const mode = modeSelect.value;
    const durationMinutes = parseInt(durationInput.value, 10) || 0;

    if (!roomId || !password) {
      joinError.textContent = "房间 ID 和密码均为必填项。";
      return;
    }

    const payload = {
      roomId,
      password,
      mode,
    };
    if (mode === "countdown") {
      payload.durationSeconds = durationMinutes * 60;
      if (!payload.durationSeconds || payload.durationSeconds <= 0) {
        joinError.textContent = "请设置大于 0 的倒计时时长。";
        return;
      }
    }

    try {
      const response = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        joinError.textContent = data.error || "加入房间失败，请稍后再试。";
        return;
      }

      currentRoomId = data.roomId;
      currentPassword = password;
      expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

      currentRoomEl.textContent = currentRoomId;
      noteArea.value = data.content || "";
      serverContent = noteArea.value;
      resetRemoteCursors(data.cursors || {});
      renderAllCursors();
      noteArea.disabled = true;
      editorCard.classList.remove("hidden");
      joinCard.classList.add("hidden");

      updateModeInfo(data.mode, expiresAt);
      updateStatus("connecting");
      noticeEl.textContent = data.created
        ? "房间已创建，正在建立实时连接…"
        : "已加入房间，正在建立实时连接…";

      openSocket();
    } catch (err) {
      console.error(err);
      joinError.textContent = "网络异常，无法加入房间。";
    }
  });

  function openSocket() {
    if (!currentRoomId || !currentPassword) {
      return;
    }
    cleanupSocket();

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/ws?roomId=${encodeURIComponent(
      currentRoomId
    )}&password=${encodeURIComponent(currentPassword)}&clientId=${encodeURIComponent(clientId)}`;

    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      updateStatus("connected");
      noteArea.disabled = false;
      noticeEl.textContent = "连接已建立，开始协作吧！";
      window.requestAnimationFrame(() => {
        renderAllCursors();
        sendCursorUpdate(true);
      });
    });

    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        handleSocketMessage(data);
      } catch (err) {
        console.error("invalid message", err);
      }
    });

    socket.addEventListener("close", () => {
      updateStatus("disconnected");
      noteArea.disabled = true;
      noticeEl.textContent = "连接已断开，如需继续请重新进入房间。";
    });

    socket.addEventListener("error", () => {
      updateStatus("disconnected");
      noteArea.disabled = true;
      noticeEl.textContent = "连接出现问题，请稍后重试。";
    });
  }

  function handleSocketMessage(message) {
    switch (message.type) {
      case "room_state":
        handleRoomState(message);
        break;
      case "content":
        handleContentBroadcast(message);
        break;
      case "cursor":
        handleCursorBroadcast(message);
        break;
      case "room_closed":
        handleRoomClosed(message);
        break;
      default:
        break;
    }
  }

  function handleRoomState(message) {
    if (typeof message.content === "string") {
      serverContent = message.content;
      setNoteContent(message.content);
    }
    expiresAt = message.expiresAt ? new Date(message.expiresAt) : null;
    updateModeInfo(message.mode, expiresAt);
    noteArea.disabled = false;
    resetRemoteCursors(message.cursors || {});
    renderAllCursors();
    scheduleCursorUpdate(true);
  }

  function handleContentBroadcast(message) {
    if (typeof message.content !== "string") {
      return;
    }
    const sender = typeof message.clientId === "string" ? message.clientId : "";
    const previousServer = serverContent;
    serverContent = message.content;

    if (sender === clientId) {
      if (noteArea.value !== message.content) {
        replaceContentPreservingSelection(message.content);
      }
      return;
    }

    applyContentDiff(previousServer, message.content);
  }

  function handleCursorBroadcast(message) {
    const sender = typeof message.clientId === "string" ? message.clientId : "";
    if (!sender || sender === clientId) {
      return;
    }

    const start = Number.isFinite(message.cursorStart) ? message.cursorStart : 0;
    const end = Number.isFinite(message.cursorEnd) ? message.cursorEnd : start;

    if (start < 0 || end < 0) {
      remoteCursors.delete(sender);
      removeCursorElement(sender);
      return;
    }

    remoteCursors.set(sender, { start, end });
    renderCursor(sender);
  }

  function handleRoomClosed(message) {
    const reason =
      message && message.reason === "expired"
        ? "房间已到期自动销毁。"
        : "房间已关闭。";
    noticeEl.textContent = reason;
    noteArea.disabled = true;
    updateStatus("disconnected");
    resetRemoteCursors({});
    renderAllCursors();
  }

  function applyContentDiff(oldContent, newContent) {
    if (oldContent === newContent) {
      return;
    }

    const localValue = noteArea.value;
    const selectionSnapshot = saveSelection();
    const diff = diffSegments(oldContent, newContent);

    if (!diff) {
      replaceContentPreservingSelection(newContent, selectionSnapshot);
      renderAllCursors();
      return;
    }

    const { start, removed, inserted } = diff;
    let applyIndex = start;

    if (localValue !== oldContent) {
      const basePrefix = oldContent.slice(0, start);
      if (basePrefix) {
        const prefixIndex = localValue.lastIndexOf(basePrefix);
        if (prefixIndex !== -1) {
          applyIndex = prefixIndex + basePrefix.length;
        }
      }
    }

    const before = localValue.slice(0, applyIndex);
    const after = localValue.slice(applyIndex + removed.length);
    noteArea.value = before + inserted + after;

    const adjusted = adjustSelectionAfterChange(
      selectionSnapshot,
      applyIndex,
      removed.length,
      inserted.length
    );
    restoreSelection(adjusted);
    renderAllCursors();
  }

  function diffSegments(previousValue, nextValue) {
    if (previousValue === nextValue) {
      return null;
    }

    let start = 0;
    const minLength = Math.min(previousValue.length, nextValue.length);
    while (start < minLength && previousValue[start] === nextValue[start]) {
      start += 1;
    }

    let prevEnd = previousValue.length - 1;
    let nextEnd = nextValue.length - 1;
    while (prevEnd >= start && nextEnd >= start && previousValue[prevEnd] === nextValue[nextEnd]) {
      prevEnd -= 1;
      nextEnd -= 1;
    }

    return {
      start,
      removed: previousValue.slice(start, prevEnd + 1),
      inserted: nextValue.slice(start, nextEnd + 1),
    };
  }

  function replaceContentPreservingSelection(nextValue, snapshot = null) {
    const selectionSnapshot = snapshot || saveSelection();
    noteArea.value = nextValue;
    restoreSelection(selectionSnapshot);
  }

  function setNoteContent(nextValue) {
    noteArea.value = nextValue;
    const length = nextValue.length;
    noteArea.setSelectionRange(length, length);
  }

  function saveSelection() {
    return {
      start: noteArea.selectionStart ?? 0,
      end: noteArea.selectionEnd ?? 0,
      direction: noteArea.selectionDirection || "none",
    };
  }

  function restoreSelection(snapshot) {
    if (!snapshot) {
      return;
    }
    const length = noteArea.value.length;
    const start = clamp(snapshot.start, 0, length);
    const end = clamp(snapshot.end, 0, length);
    noteArea.setSelectionRange(start, end, snapshot.direction || "none");
  }

  function adjustSelectionAfterChange(snapshot, index, removedLength, insertedLength) {
    if (!snapshot) {
      return null;
    }
    const delta = insertedLength - removedLength;
    const changeEnd = index + removedLength;

    let { start, end } = snapshot;

    if (start >= changeEnd) {
      start += delta;
    } else if (start >= index) {
      start = index + Math.min(insertedLength, start - index);
    }

    if (end >= changeEnd) {
      end += delta;
    } else if (end >= index) {
      end = index + Math.min(insertedLength, end - index);
    }

    if (start > end) {
      const tmp = start;
      start = end;
      end = tmp;
    }

    return {
      start,
      end,
      direction: snapshot.direction,
    };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function resetRemoteCursors(snapshotCursors) {
    remoteCursors.clear();
    cursorElements.forEach((el) => el.remove());
    cursorElements.clear();

    if (snapshotCursors && typeof snapshotCursors === "object") {
      Object.entries(snapshotCursors).forEach(([id, state]) => {
        if (id === clientId || !state) {
          return;
        }
        const start = Number.isFinite(state.start) ? state.start : 0;
        const end = Number.isFinite(state.end) ? state.end : start;
        remoteCursors.set(id, { start, end });
      });
    }
  }

  function renderAllCursors() {
    if (!cursorOverlay || noteArea.disabled) {
      return;
    }
    syncMirrorStyles();
    const toRemove = new Set(cursorElements.keys());
    remoteCursors.forEach((state, id) => {
      renderCursor(id, state);
      toRemove.delete(id);
    });
    toRemove.forEach((id) => removeCursorElement(id));
  }

  function renderCursor(client, state) {
    if (!cursorOverlay || !state) {
      return;
    }
    const caretIndex = Math.max(0, Number.isFinite(state.end) ? state.end : state.start || 0);
    const coords = getCaretCoordinates(caretIndex);
    if (!coords) {
      return;
    }

    let element = cursorElements.get(client);
    if (!element) {
      element = document.createElement("div");
      element.className = "remote-caret";
      const label = document.createElement("span");
      label.className = "remote-label";
      label.textContent = formatCursorLabel(client);
      element.appendChild(label);
      const color = assignCursorColor(client);
      element.style.backgroundColor = color;
      label.style.backgroundColor = color;
      cursorOverlay.appendChild(element);
      cursorElements.set(client, element);
    }

    const lineHeight = getLineHeight();
    element.style.height = `${lineHeight}px`;
    element.style.transform = `translate(${coords.left}px, ${coords.top}px)`;
  }

  function removeCursorElement(client) {
    const element = cursorElements.get(client);
    if (element && element.parentElement) {
      element.parentElement.removeChild(element);
    }
    cursorElements.delete(client);
  }

  function syncMirrorStyles() {
    if (!caretMirror || !noteArea) {
      return;
    }
    const style = window.getComputedStyle(noteArea);
    caretMirror.style.font = style.font;
    caretMirror.style.letterSpacing = style.letterSpacing;
    caretMirror.style.textTransform = style.textTransform;
    caretMirror.style.padding = style.padding;
    caretMirror.style.width = `${noteArea.clientWidth}px`;
    caretMirror.style.lineHeight = style.lineHeight;
  }

  function getCaretCoordinates(index) {
    if (!caretMirror) {
      return null;
    }
    syncMirrorStyles();

    const value = noteArea.value;
    const marker = document.createElement("span");
    marker.textContent = "\u200b";

    caretMirror.textContent = "";
    caretMirror.appendChild(document.createTextNode(value.slice(0, index)));
    caretMirror.appendChild(marker);
    caretMirror.appendChild(document.createTextNode(value.slice(index) || " "));

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = caretMirror.getBoundingClientRect();

    const top = markerRect.top - mirrorRect.top - noteArea.scrollTop;
    const left = markerRect.left - mirrorRect.left - noteArea.scrollLeft;
    return { top, left };
  }

  function getLineHeight() {
    const line = parseFloat(window.getComputedStyle(noteArea).lineHeight);
    if (Number.isFinite(line)) {
      return line;
    }
    return 24;
  }

  function assignCursorColor(id) {
    if (cursorColors.has(id)) {
      return cursorColors.get(id);
    }
    const color = cursorPalette[cursorColors.size % cursorPalette.length];
    cursorColors.set(id, color);
    return color;
  }

  function formatCursorLabel(id) {
    return id.slice(-4) || id;
  }

  function isNavigationKey(event) {
    if (!event || typeof event.key !== "string") {
      return false;
    }
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
      case "Home":
      case "End":
      case "PageUp":
      case "PageDown":
        return true;
      default:
        return false;
    }
  }

  function scheduleCursorUpdate(immediate = false) {
    if (!socket || socket.readyState !== WebSocket.OPEN || noteArea.disabled) {
      return;
    }
    if (immediate) {
      sendCursorUpdate(true);
      return;
    }
    if (cursorTimer) {
      window.clearTimeout(cursorTimer);
    }
    cursorTimer = window.setTimeout(() => sendCursorUpdate(), CURSOR_THROTTLE_MS);
  }

  function sendCursorUpdate(force = false) {
    if (!socket || socket.readyState !== WebSocket.OPEN || noteArea.disabled) {
      return;
    }
    const start = noteArea.selectionStart ?? 0;
    const end = noteArea.selectionEnd ?? start;
    if (!force && start === lastCursorSent.start && end === lastCursorSent.end) {
      return;
    }
    lastCursorSent = { start, end };
    const payload = JSON.stringify({
      type: "cursor",
      cursorStart: start,
      cursorEnd: end,
    });
    socket.send(payload);
  }

  function ensureClientId() {
    const storageKey = "shared-notebook-client-id";
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing && typeof existing === "string") {
      return existing;
    }
    const generated = generateClientId();
    try {
      window.sessionStorage.setItem(storageKey, generated);
    } catch (err) {
      console.warn("Unable to persist client id", err);
    }
    return generated;
  }

  function generateClientId() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    const array = new Uint32Array(4);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(array);
    } else {
      for (let i = 0; i < array.length; i += 1) {
        array[i] = Math.floor(Math.random() * 0xffffffff);
      }
    }
    return Array.from(array)
      .map((value) => value.toString(16).padStart(8, "0"))
      .join("");
  }

  noteArea.addEventListener("input", () => {
    renderAllCursors();
    scheduleCursorUpdate();

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (sendTimer) {
      clearTimeout(sendTimer);
    }
    const content = noteArea.value;
    sendTimer = window.setTimeout(() => {
      trySendContent(content);
    }, 200);
  });

  noteArea.addEventListener("scroll", renderAllCursors);
  noteArea.addEventListener("mouseup", () => scheduleCursorUpdate(true));
  noteArea.addEventListener("focus", () => {
    renderAllCursors();
    scheduleCursorUpdate(true);
  });
  noteArea.addEventListener("keyup", (event) => {
    if (isNavigationKey(event)) {
      scheduleCursorUpdate();
    }
  });

  document.addEventListener("selectionchange", () => {
    if (document.activeElement === noteArea) {
      scheduleCursorUpdate();
    }
  });

  window.addEventListener("resize", renderAllCursors);

  function trySendContent(content) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = JSON.stringify({ type: "content", content });
    socket.send(payload);
    serverContent = content;
  }

  function updateModeInfo(mode, expires) {
    clearCountdown();

    if (mode === "countdown" && expires instanceof Date && !Number.isNaN(expires.getTime())) {
      modeInfoEl.textContent = "模式：倒计时销毁";
      updateCountdown(expires);
      countdownTimer = window.setInterval(() => updateCountdown(expires), 1000);
    } else {
      modeInfoEl.textContent = "模式：永久保存";
    }
  }

  function updateCountdown(expireTime) {
    const remaining = expireTime.getTime() - Date.now();
    if (remaining <= 0) {
      clearCountdown();
      noticeEl.textContent = "房间已到期，即将断开连接…";
      return;
    }
    const seconds = Math.floor(remaining / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    noticeEl.textContent = `距离房间销毁还剩 ${minutes}分${secs.toString().padStart(2, "0")}秒`;
  }

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function updateStatus(state) {
    switch (state) {
      case "connected":
        statusEl.textContent = "状态：已连接";
        statusEl.classList.add("connected");
        statusEl.classList.remove("disconnected");
        break;
      case "connecting":
        statusEl.textContent = "状态：连接中…";
        statusEl.classList.remove("connected", "disconnected");
        break;
      default:
        statusEl.textContent = "状态：已断开";
        statusEl.classList.add("disconnected");
        statusEl.classList.remove("connected");
        break;
    }
  }

  function cleanupSocket() {
    if (socket) {
      socket.close();
      socket = null;
    }
    if (cursorTimer) {
      window.clearTimeout(cursorTimer);
      cursorTimer = null;
    }
    if (sendTimer) {
      window.clearTimeout(sendTimer);
      sendTimer = null;
    }
    remoteCursors.clear();
    cursorElements.forEach((el) => el.remove());
    cursorElements.clear();
    lastCursorSent = { start: -1, end: -1 };
  }

  window.addEventListener("beforeunload", cleanupSocket);
})();
