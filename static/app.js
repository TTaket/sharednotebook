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
  const currentRoomEl = document.getElementById("current-room");
  const modeInfoEl = document.getElementById("mode-info");
  const statusEl = document.getElementById("connection-status");
  const noticeEl = document.getElementById("room-notice");

  let countdownTimer = null;
  let expiresAt = null;
  let socket = null;
  let currentRoomId = "";
  let currentPassword = "";
  let sendTimer = null;

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
    )}&password=${encodeURIComponent(currentPassword)}`;

    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      updateStatus("connected");
      noteArea.disabled = false;
      noticeEl.textContent = "连接已建立，开始协作吧！";
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
        if (typeof message.content === "string") {
          noteArea.value = message.content;
        }
        expiresAt = message.expiresAt ? new Date(message.expiresAt) : null;
        updateModeInfo(message.mode, expiresAt);
        noteArea.disabled = false;
        break;
      case "content":
        if (typeof message.content === "string" && noteArea.value !== message.content) {
          noteArea.value = message.content;
        }
        break;
      case "room_closed":
        const reason =
          message.reason === "expired" ? "房间已到期自动销毁。" : "房间已关闭。";
        noticeEl.textContent = reason;
        noteArea.disabled = true;
        updateStatus("disconnected");
        break;
      default:
        break;
    }
  }

  noteArea.addEventListener("input", () => {
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

  function trySendContent(content) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = JSON.stringify({ type: "content", content });
    socket.send(payload);
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
  }

  window.addEventListener("beforeunload", cleanupSocket);
})();
