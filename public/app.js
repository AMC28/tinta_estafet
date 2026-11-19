(function () {
  // Penyimpanan sesi lokal & identitas perangkat (1 Device = 1 Orang)
  const STORAGE_KEYS = {
    DEVICE_ID: "tinta_estafet_device_id",
    ROLE: "tinta_estafet_role",
    PLAYER_ID: "tinta_estafet_player_id",
    PLAYER_NAME: "tinta_estafet_player_name",
    GM_PIN: "tinta_estafet_gm_pin",
    CUSTOM_INVITE_URL: "tinta_estafet_invite_url"
  };

  function getOrCreateDeviceId() {
    // Cek cookie terlebih dahulu
    const match = document.cookie.match(/(?:^|;\s*)tinta_device_id=([^;]+)/);
    const cookieVal = match ? decodeURIComponent(match[1]) : "";
    let devId = localStorage.getItem(STORAGE_KEYS.DEVICE_ID) || cookieVal;
    if (!devId) {
      devId =
        "dev-" +
        (typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36));
    }
    localStorage.setItem(STORAGE_KEYS.DEVICE_ID, devId);
    document.cookie = `tinta_device_id=${encodeURIComponent(devId)}; path=/; max-age=86400; SameSite=Lax`;
    return devId;
  }

  const client = {
    deviceId: getOrCreateDeviceId(),
    role: localStorage.getItem(STORAGE_KEYS.ROLE) || null, // null | "player" | "game_master"
    playerId: localStorage.getItem(STORAGE_KEYS.PLAYER_ID) || null,
    playerName: localStorage.getItem(STORAGE_KEYS.PLAYER_NAME) || "",
    gmPin: localStorage.getItem(STORAGE_KEYS.GM_PIN) || "",
    state: null,
    ws: null,
    selectedColor: "#000000",
    selectedBrushSize: 6,
    isEraser: false,
    isDrawingPointerDown: false,
    lastPoint: null,
    gmShowSecretWords: false, // Default sembunyikan kata rahasia di layar proyektor GM
    renderedViewKey: "",
    renderedStrokeCount: 0,
    serverTimeOffset: 0,
    customInviteUrl: localStorage.getItem(STORAGE_KEYS.CUSTOM_INVITE_URL) || ""
  };

  // Web Audio Synthesizer sederhana untuk efek suara interaktif
  const audioCtx = typeof AudioContext !== "undefined" ? new AudioContext() : null;
  function playTone(freq = 520, duration = 0.12, type = "sine") {
    if (!audioCtx) return;
    try {
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {}
  }

  function showToast(msg, borderColor = "#6366f1") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.style.borderLeftColor = borderColor;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3200);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Koneksi WebSocket Real-time
  function connectWebSocket() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    client.ws = ws;

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "IDENTIFY",
          role: client.role || "player",
          playerId: client.playerId,
          deviceId: client.deviceId,
          pin: client.gmPin
        })
      );
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "PLAYER_KICKED") {
          if (client.role === "player" && (!msg.playerId || msg.playerId === client.playerId)) {
            client.role = null;
            client.playerId = null;
            localStorage.removeItem(STORAGE_KEYS.ROLE);
            localStorage.removeItem(STORAGE_KEYS.PLAYER_ID);
            showToast(msg.message || "Kamu telah dikeluarkan oleh Game Master.", "#f43f5e");
            playTone(300, 0.2, "sawtooth");
            client.renderedViewKey = "";
            updateTopbar();
            renderMainView();
          }
          return;
        }
        if (msg.type === "STATE_UPDATE") {
          handleStateUpdate(msg.state);
        } else if (msg.type === "STROKE_STREAM") {
          handleLiveStrokeStream(msg);
        }
      } catch (e) {}
    });

    ws.addEventListener("close", () => {
      setTimeout(connectWebSocket, 1500);
    });
  }

  // Mengirim Action ke Server (via HTTP POST agar selalu mendapat callback result langsung + memicu WS broadcast)
  async function sendAction(action, payload = {}) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (client.role === "game_master" && client.gmPin) {
        headers["X-GM-Pin"] = client.gmPin;
      }
      const resp = await fetch("/api/action", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action,
          payload: { ...payload, deviceId: client.deviceId },
          role: client.role || "player",
          playerId: client.playerId,
          deviceId: client.deviceId,
          gmPin: client.role === "game_master" ? client.gmPin : ""
        })
      });
      const data = await resp.json();
      if (data.requireGmAuth && client.role === "game_master") {
        client.role = null;
        client.gmPin = "";
        localStorage.removeItem(STORAGE_KEYS.ROLE);
        localStorage.removeItem(STORAGE_KEYS.GM_PIN);
        client.renderedViewKey = "";
        showToast(data.error || "Sesi Game Master berakhir, silakan masukkan PIN baru.", "#f43f5e");
        const modal = document.getElementById("gmPinModal");
        if (modal) modal.classList.remove("hidden");
      }
      if (data.state) {
        handleStateUpdate(data.state);
      }
      return data;
    } catch (err) {
      showToast("Gagal menghubungi server", "#f43f5e");
      return { ok: false, error: err.message };
    }
  }

  // Kirim segmen goresan langsung via WebSocket agar bebas latensi
  function sendStrokeSegmentWS(groupId, segment) {
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(
        JSON.stringify({
          type: "ACTION",
          action: "DRAW_STROKE",
          payload: {
            groupId,
            playerId: client.playerId,
            segment
          }
        })
      );
    } else {
      sendAction("DRAW_STROKE", { groupId, playerId: client.playerId, segment });
    }
  }

  // Menentukan apakah perangkat ini sudah terikat pada 1 pemain di server (1 Device = 1 Orang)
  function syncSessionWithState(state) {
    if (client.role === "game_master") return;

    if (client.role === "player" && client.playerId) {
      const found = state.players.find((p) => p.id === client.playerId);
      if (!found) {
        // Jika pemain sudah tidak ada di daftar server (misal karena di-kick GM),
        // kembalikan ke halaman masuk.
        client.role = null;
        client.playerId = null;
        localStorage.removeItem(STORAGE_KEYS.ROLE);
        localStorage.removeItem(STORAGE_KEYS.PLAYER_ID);
      }
    }

    // Jika perangkat ini (berdasarkan deviceId) sudah terdaftar sebagai pemain di server,
    // otomatis kunci sesi browser ini ke pemain tersebut agar tidak bisa daftar pemain ke-2 di tab/window lain.
    if (!client.role && state.boundPlayer) {
      client.role = "player";
      client.playerId = state.boundPlayer.id;
      client.playerName = state.boundPlayer.name;
      localStorage.setItem(STORAGE_KEYS.ROLE, "player");
      localStorage.setItem(STORAGE_KEYS.PLAYER_ID, state.boundPlayer.id);
      localStorage.setItem(STORAGE_KEYS.PLAYER_NAME, state.boundPlayer.name);
    }
  }

  function handleStateUpdate(newState) {
    const prevState = client.state;

    if (newState && typeof newState.serverTime === "number") {
      client.serverTimeOffset = newState.serverTime - Date.now();
    }

    // Jika server mengirim state ringan (strokesOmitted) saat menebak gambar,
    // pertahankan data strokes kanvas yang sudah ada di memori browser agar hemat bandwidth
    if (
      newState &&
      newState.strokesOmitted &&
      prevState &&
      Array.isArray(prevState.groups) &&
      Array.isArray(newState.groups)
    ) {
      newState.groups.forEach((g) => {
        const prevG = prevState.groups.find((pg) => pg.id === g.id);
        if (prevG && Array.isArray(prevG.strokes)) {
          g.strokes = prevG.strokes;
        } else if (!Array.isArray(g.strokes)) {
          g.strokes = [];
        }
      });
    }

    client.state = newState;
    syncSessionWithState(newState);
    updateTopbar();

    // Jika sedang di fase DRAWING dan struktur giliran/fase tidak berubah, update elemen secara in-place
    // agar pemain yang sedang menekan jari/mouse di kanvas tidak terputus goresannya
    const newViewKey = computeViewKey(newState);
    // Jangan re-render halaman ENTRY jika sudah tampil, agar ketikan nama/klik tombol tidak terputus saat ada STATE_UPDATE
    if (client.renderedViewKey === "ENTRY" && newViewKey === "ENTRY") {
      return;
    }

    if (
      prevState &&
      client.renderedViewKey === newViewKey &&
      newState.phase === "DRAWING"
    ) {
      updateDrawingViewInPlace();
      return;
    }

    if (
      prevState &&
      client.renderedViewKey === newViewKey &&
      newState.phase === "GUESSING"
    ) {
      updateGuessingViewInPlace();
      return;
    }

    client.renderedViewKey = newViewKey;
    renderMainView();
  }

  function computeViewKey(st) {
    if (!client.role) return "ENTRY";
    if (!st) return "LOADING";
    if (client.role === "game_master" && st.phase === "DRAWING") {
      const gmGroupsKey = st.groups
        .map((g) => `${g.id}:${g.status}:${g.currentTurnIndex}`)
        .join(",");
      return `${client.role}:${st.phase}:R${st.roundNumber}:${gmGroupsKey}`;
    }
    const me = st.players.find((p) => p.id === client.playerId);
    const myGroupId = me ? me.groupId : 0;
    const myGroup = st.groups.find((g) => g.id === myGroupId);
    const myGroupStatus = myGroup ? `${myGroup.status}-${myGroup.currentTurnIndex}` : "NONE";
    return `${client.role}:${st.phase}:R${st.roundNumber}:G${myGroupId}:${myGroupStatus}:AG${st.activeGuessGroupIndex}`;
  }

  function updateTopbar() {
    const st = client.state;
    if (!st) return;

    const roundPill = document.getElementById("roundPill");
    const phasePill = document.getElementById("phasePill");
    const rolePill = document.getElementById("rolePill");
    const switchRoleBtn = document.getElementById("switchRoleBtn");
    const returnLobbyTopBtn = document.getElementById("returnLobbyTopBtn");

    roundPill.textContent = `Ronde ${st.roundNumber || 1}`;

    const phaseLabels = {
      LOBBY: "1. LOBBY",
      DRAWING: "2. MENGGAMBAR ESTAFET",
      READY_TO_GUESS: "3. SIAP MENEBAK",
      GUESSING: "4. MENEBAK GAMBAR",
      REVEAL: "5. REVEAL JAWABAN",
      LEADERBOARD: "6. LEADERBOARD AKHIR"
    };
    phasePill.textContent = phaseLabels[st.phase] || st.phase;

    if (returnLobbyTopBtn) {
      if (client.role === "game_master" && st.phase !== "LOBBY") {
        returnLobbyTopBtn.classList.remove("hidden");
      } else {
        returnLobbyTopBtn.classList.add("hidden");
      }
    }

    if (client.role === "game_master") {
      rolePill.className = "pill gm-pill";
      rolePill.textContent = "👑 Mode Game Master";
      switchRoleBtn.textContent = "Keluar Mode GM";
      switchRoleBtn.classList.remove("hidden");
    } else if (client.role === "player") {
      const me = st.players.find((p) => p.id === client.playerId);
      rolePill.className = "pill";
      rolePill.textContent = me
        ? `👤 ${me.name} (Grup ${me.groupId})`
        : `👤 ${client.playerName}`;
      // 1 Device = 1 Orang: Pemain tidak bisa keluar untuk membuat pemain baru, hanya bisa masuk Mode Admin dengan PIN
      switchRoleBtn.textContent = "👑 Mode Admin";
      switchRoleBtn.classList.remove("hidden");
    } else {
      rolePill.className = "pill hidden";
      switchRoleBtn.classList.add("hidden");
    }
  }

  // Menggambar segmen garis pada elemen Canvas
  function drawSegmentOnCanvas(ctx, seg) {
    if (!ctx || !seg) return;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = seg.color || "#000000";
    ctx.lineWidth = seg.size || 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
    ctx.restore();
  }

  function renderAllStrokesOnCanvas(canvas, strokes) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    (strokes || []).forEach((seg) => drawSegmentOnCanvas(ctx, seg));
  }

  // Menangani stream goresan real-time dari WebSocket
  function handleLiveStrokeStream(msg) {
    if (!client.state) return;
    const group = client.state.groups.find((g) => g.id === msg.groupId);
    if (group) {
      group.strokes.push(msg.segment);
      if (msg.inkInfo) {
        group.remainingInk = msg.inkInfo.remainingInk;
        group.turnInkRemaining = msg.inkInfo.turnInkRemaining;
        group.turnInkLimit = msg.inkInfo.turnInkLimit;
        group.remainingInkPct = Math.round(
          (Math.max(0, group.remainingInk) / Math.max(1, group.initialInk)) * 100
        );
      }
    }

    // Jika kanvas grup ini sedang tampil di layar pemain, gambar langsung segmennya
    const mainCanvas = document.getElementById(`groupCanvas-${msg.groupId}`);
    if (mainCanvas) {
      // Hindari menggambar ganda jika pemain ini sendiri yang baru saja menggambar secara lokal
      if (msg.segment.playerId !== client.playerId || !client.isDrawingPointerDown) {
        drawSegmentOnCanvas(mainCanvas.getContext("2d"), msg.segment);
      }
    }
    updateInkMetersDOM(msg.groupId);
  }

  function updateInkMetersDOM(groupId) {
    if (!client.state) return;
    const g = client.state.groups.find((gr) => gr.id === groupId);
    if (!g) return;

    const groupInkText = document.getElementById(`groupInkText-${groupId}`);
    const groupInkBar = document.getElementById(`groupInkBar-${groupId}`);
    if (groupInkText) {
      groupInkText.textContent = `${g.remainingInk} / ${g.initialInk} (${g.remainingInkPct}%)`;
    }
    if (groupInkBar) {
      groupInkBar.style.width = `${Math.max(0, Math.min(100, g.remainingInkPct))}%`;
    }

    const turnInkText = document.getElementById(`turnInkText-${groupId}`);
    const turnInkBar = document.getElementById(`turnInkBar-${groupId}`);
    const turnPct =
      g.turnInkLimit > 0
        ? Math.round((Math.max(0, g.turnInkRemaining) / g.turnInkLimit) * 100)
        : 0;
    if (turnInkText) {
      turnInkText.textContent = `${g.turnInkRemaining} / ${g.turnInkLimit} (${turnPct}%)`;
    }
    if (turnInkBar) {
      turnInkBar.style.width = `${Math.max(0, Math.min(100, turnPct))}%`;
      if (turnPct < 20) turnInkBar.classList.add("danger");
      else turnInkBar.classList.remove("danger");
    }
  }

  // Render tampilan utama berdasarkan role & phase
  function renderMainView() {
    const container = document.getElementById("mainView");
    if (!container) return;

    if (!client.role) {
      renderEntryView(container);
      return;
    }

    const st = client.state;
    if (!st) {
      container.innerHTML = `<div class="card" style="text-align:center;padding:48px;">Memuat permainan...</div>`;
      return;
    }

    switch (st.phase) {
      case "LOBBY":
        renderLobbyView(container, st);
        break;
      case "DRAWING":
        renderDrawingView(container, st);
        break;
      case "READY_TO_GUESS":
        renderReadyToGuessView(container, st);
        break;
      case "GUESSING":
        renderGuessingView(container, st);
        break;
      case "REVEAL":
        renderRevealView(container, st);
        break;
      case "LEADERBOARD":
        renderLeaderboardView(container, st);
        break;
      default:
        renderLobbyView(container, st);
    }
  }

  // ============================================================================
  // 0. HALAMAN MASUK (ENTRY SCREEN)
  // ============================================================================
  function renderEntryView(container) {
    container.innerHTML = `
      <div style="max-width:480px;margin:28px auto;">
        <div class="card" style="text-align:center;padding:28px 24px;">
          <div style="font-size:3rem;margin-bottom:10px;">🖌️🤝🎨</div>
          <h1 style="font-size:1.65rem;font-weight:800;margin-bottom:6px;">Selamat Datang di Tinta Estafet!</h1>
          <p style="color:var(--text-muted);font-size:0.92rem;margin-bottom:24px;">
            Game estafet menggambar multiplayer. Masuk dengan nama panggilanmu dan otomatis bergabung ke dalam grup!
          </p>

          <form id="joinPlayerForm" style="text-align:left;">
            <label style="display:block;font-size:0.85rem;font-weight:700;margin-bottom:6px;color:#cbd5e1;">
              Nama Panggilan Pemain
            </label>
            <input
              id="playerNameInput"
              type="text"
              class="input-field"
              placeholder="Contoh: Budi, Rina, Alex..."
              maxlength="24"
              value="${escapeHtml(client.playerName)}"
              required
              style="margin-bottom:14px;"
            />
            <button type="submit" class="btn btn-emerald btn-lg">
              Masuk &amp; Gabung Grup Otomatis ➔
            </button>
          </form>

          <div style="margin:24px 0 16px;border-top:1px solid var(--border-color);padding-top:18px;">
            <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:10px;">
              Atau apakah kamu pemandu acara / pemilik ruangan?
            </p>
            <button id="openGmAuthBtn" type="button" class="btn btn-outline" style="width:100%;">
              👑 Masuk sebagai Game Master (PIN)
            </button>
          </div>
        </div>
      </div>
    `;

    const form = document.getElementById("joinPlayerForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("playerNameInput").value.trim();
      if (!name) return;
      const res = await sendAction("JOIN_PLAYER", {
        name,
        playerId: client.playerId
      });
      if (!res.ok) {
        showToast(res.error || "Gagal masuk", "#f43f5e");
        return;
      }
      client.role = "player";
      client.playerId = res.player.id;
      client.playerName = res.player.name;
      localStorage.setItem(STORAGE_KEYS.ROLE, "player");
      localStorage.setItem(STORAGE_KEYS.PLAYER_ID, res.player.id);
      localStorage.setItem(STORAGE_KEYS.PLAYER_NAME, res.player.name);

      if (client.ws && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(
          JSON.stringify({
            type: "IDENTIFY",
            role: "player",
            playerId: client.playerId
          })
        );
      }
      playTone(640, 0.15);
      client.renderedViewKey = "";
      renderMainView();
    });

    document.getElementById("openGmAuthBtn").addEventListener("click", () => {
      document.getElementById("gmPinModal").classList.remove("hidden");
      document.getElementById("gmPinInput").focus();
    });
  }

  // ============================================================================
  // 1. FASE LOBBY (STEP 1)
  // ============================================================================
  function getInviteUrl(st) {
    if (client.customInviteUrl && client.customInviteUrl.trim()) {
      return client.customInviteUrl.trim();
    }
    const loc = window.location;
    if (
      (loc.hostname === "localhost" || loc.hostname === "127.0.0.1") &&
      st.localIPs &&
      st.localIPs.length > 0
    ) {
      return `${loc.protocol}//${st.localIPs[0]}:${st.port || loc.port || 3000}`;
    }
    return loc.origin;
  }

  function renderLobbyView(container, st) {
    const isGM = client.role === "game_master";
    const me = st.players.find((p) => p.id === client.playerId);
    const inviteUrl = getInviteUrl(st);
    const qrSvg = window.renderQRCodeSVG ? window.renderQRCodeSVG(inviteUrl, 175) : "";

    const groupsHtml = st.groups
      .map((g) => {
        const isMyGroup = me && me.groupId === g.id;
        const membersHtml =
          g.members.length === 0
            ? `<li style="color:var(--text-muted);font-size:0.84rem;padding:8px 4px;">Belum ada anggota</li>`
            : g.members
                .map((m, mIdx) => {
                  const isMe = m.id === client.playerId;
                  const moveOptions = st.groups
                    .map(
                      (grp) =>
                        `<option value="${grp.id}" ${grp.id === g.id ? "selected" : ""}>Grup ${grp.id}</option>`
                    )
                    .join("");

                  return `
                    <li class="member-item ${isMe ? "is-me" : ""}" style="flex-wrap:wrap;gap:6px;">
                      <div style="display:flex;align-items:center;min-width:0;">
                        <span class="turn-badge">#${m.turnOrder}</span>
                        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.name)}</span>
                        ${m.isBot ? `<span style="font-size:0.72rem;color:#38bdf8;margin-left:4px;">[BOT]</span>` : ""}
                        ${isMe ? `<span style="font-size:0.72rem;color:#a5b4fc;margin-left:4px;">(Kamu)</span>` : ""}
                      </div>
                      ${
                        isGM
                          ? `<div style="display:flex;align-items:center;gap:4px;">
                              <select
                                class="move-group-select"
                                data-id="${m.id}"
                                title="Pindahkan pemain ke grup lain"
                                style="background:rgba(15,23,42,0.85);color:#f8fafc;border:1px solid var(--border-color);border-radius:6px;padding:2px 6px;font-size:0.74rem;cursor:pointer;"
                              >
                                ${moveOptions}
                              </select>
                              <button
                                class="btn btn-outline btn-sm move-order-btn"
                                data-id="${m.id}"
                                data-dir="UP"
                                ${mIdx === 0 ? "disabled" : ""}
                                style="padding:2px 6px;font-size:0.72rem;"
                                title="Majukan urutan giliran"
                              >↑</button>
                              <button
                                class="btn btn-outline btn-sm move-order-btn"
                                data-id="${m.id}"
                                data-dir="DOWN"
                                ${mIdx === g.members.length - 1 ? "disabled" : ""}
                                style="padding:2px 6px;font-size:0.72rem;"
                                title="Mundurkan urutan giliran"
                              >↓</button>
                              <button
                                class="btn btn-outline btn-sm kick-player-btn"
                                data-id="${m.id}"
                                style="padding:2px 8px;font-size:0.72rem;"
                                title="Keluarkan"
                              >✕</button>
                            </div>`
                          : `<span style="font-size:0.75rem;color:var(--text-muted);">Giliran ${m.turnOrder}</span>`
                      }
                    </li>
                  `;
                })
                .join("");

        return `
          <div class="group-card" style="border-color:${isMyGroup ? g.color : "rgba(255,255,255,0.08)"};">
            <div class="group-header">
              <div class="group-badge">
                <span class="group-dot" style="background:${g.color};"></span>
                <span>${escapeHtml(g.fullName)}</span>
              </div>
              <span style="font-size:0.78rem;color:var(--text-muted);">${g.members.length} pemain</span>
            </div>
            ${
              g.scoreBreakdown && g.scoreBreakdown.accumulatedTotal > 0
                ? `<div style="font-size:0.76rem;color:#10b981;font-weight:700;margin-bottom:8px;">
                    🏆 Total Skor Akumulasi: ${g.scoreBreakdown.accumulatedTotal} Poin
                  </div>`
                : ""
            }
            <ul class="member-list">${membersHtml}</ul>
          </div>
        `;
      })
      .join("");

    if (isGM) {
      container.innerHTML = `
        <div class="grid-sidebar">
          <!-- Panel Kiri: QR Code + Pengaturan Game Master -->
          <div style="display:flex;flex-direction:column;gap:16px;">
            <div class="card" style="text-align:center;">
              <h3 style="font-size:1.05rem;margin-bottom:8px;">📲 Undang Pemain (Maks ${st.maxPlayers})</h3>
              <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px;">
                Scan QR Code atau bagikan link di bawah agar pemain langsung masuk grup otomatis:
              </p>
              <div style="margin-bottom:12px;">${qrSvg}</div>
              <div style="background:rgba(15,23,42,0.75);padding:8px 10px;border-radius:8px;font-family:monospace;font-size:0.82rem;word-break:break-all;margin-bottom:10px;border:1px solid var(--border-color);">
                ${escapeHtml(inviteUrl)}
              </div>
              <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
                <button id="copyInviteBtn" class="btn btn-outline btn-sm">📋 Salin Link</button>
                <button id="setCustomUrlBtn" class="btn btn-outline btn-sm" title="Ubah URL jika memakai Public Tunnel / Hosting">🌐 Ubah URL Publik</button>
              </div>
            </div>

            <div class="card">
              <h3 style="font-size:1.05rem;margin-bottom:12px;">⚙️ Pengaturan Permainan</h3>

              <div style="margin-bottom:12px;">
                <label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">
                  Kapasitas Maksimal Pemain
                </label>
                <select id="settingMaxPlayers" class="select-field">
                  ${[20, 30, 40, 50, 60]
                    .map(
                      (cap) =>
                        `<option value="${cap}" ${(st.settings.maxPlayers || st.maxPlayers) === cap ? "selected" : ""}>Maksimal ${cap} Pemain</option>`
                    )
                    .join("")}
                </select>
              </div>

              <div style="margin-bottom:12px;">
                <label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">
                  Jumlah Grup ${st.teamsLocked ? "(Terkunci di Ronde " + st.roundNumber + ")" : ""}
                </label>
                <select id="settingGroupCount" class="select-field" ${st.teamsLocked ? "disabled" : ""}>
                  ${[2, 3, 4, 5, 6, 7, 8]
                    .map(
                      (n) =>
                        `<option value="${n}" ${st.settings.groupCount === n ? "selected" : ""}>${n} Grup</option>`
                    )
                    .join("")}
                </select>
              </div>

              <div style="margin-bottom:12px;">
                <label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">Porsi Tinta Per Orang</label>
                <select id="settingInkMode" class="select-field">
                  ${Object.entries(st.inkCapacityModes)
                    .map(
                      ([key, info]) =>
                        `<option value="${key}" ${st.settings.inkCapacityMode === key ? "selected" : ""}>${key} (${info.ink_per_player || info.total_group_ink} Tinta / Orang) — ${info.description}</option>`
                    )
                    .join("")}
                </select>
              </div>

              <div style="margin-bottom:12px;">
                <label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">Durasi Giliran per Pemain</label>
                <select id="settingTurnDuration" class="select-field">
                  <option value="0" ${st.settings.turnDurationSeconds === 0 ? "selected" : ""}>
                    ♾️ Tanpa Batas Waktu (Sampai Tinta Habis / Klik Pass)
                  </option>
                  ${[15, 20, 30]
                    .map(
                      (sec) =>
                        `<option value="${sec}" ${st.settings.turnDurationSeconds === sec ? "selected" : ""}>${sec} Detik / Giliran</option>`
                    )
                    .join("")}
                </select>
              </div>

              <div style="margin-bottom:12px;">
                <label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">Aturan Sisa Tinta Saat Klik Pass</label>
                <select id="settingPassBehavior" class="select-field">
                  <option value="PORSI_TETAP" ${st.settings.passInkBehavior === "PORSI_TETAP" ? "selected" : ""}>
                    PORSI TETAP (Jatah tiap orang tetap, sisa tinta ditabung untuk Bonus Grup)
                  </option>
                  <option value="INHERITED" ${st.settings.passInkBehavior === "INHERITED" ? "selected" : ""}>
                    INHERITED (Sisa tinta diwariskan ke teman grup berikutnya)
                  </option>
                  <option value="WASTED" ${st.settings.passInkBehavior === "WASTED" ? "selected" : ""}>
                    WASTED (Sisa jatah tinta pemain tersebut hangus)
                  </option>
                </select>
              </div>

              <div style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">
                <label for="settingFuzzy" style="font-size:0.82rem;color:#cbd5e1;cursor:pointer;">
                  Notifikasi "Hampir Benar" Saat Tebakan Mendekati (Fuzzy)
                </label>
                <input id="settingFuzzy" type="checkbox" ${st.settings.fuzzyMatching ? "checked" : ""} style="width:18px;height:18px;cursor:pointer;" />
              </div>

              <button id="openWordBankBtn" class="btn btn-outline btn-sm" style="width:100%;">
                📚 Edit Word Bank (${st.customWordsCount} Kata Objek)
              </button>
            </div>
          </div>

          <!-- Panel Kanan: Daftar Grup, Bot & Kontrol Mulai -->
          <div style="display:flex;flex-direction:column;gap:16px;">
            <div class="card">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
                <div>
                  <h2 style="font-size:1.25rem;font-weight:800;">
                    👥 Pembagian Grup &amp; Urutan Giliran (${st.players.length}/${st.maxPlayers} Pemain)
                  </h2>
                  <p style="font-size:0.82rem;color:var(--text-muted);">
                    ${
                      st.teamsLocked
                        ? `🔒 <strong>Tim Terkunci dari Ronde 1</strong> (Grup tidak diacak ulang di Ronde ${st.roundNumber}. Kamu tetap bisa memindahkan pemain secara manual atau klik <strong>Reset Semua</strong>).`
                        : `Gunakan dropdown pada tiap pemain untuk memindahkan grup atau tombol ↑/↓ untuk mengatur urutan giliran.`
                    }
                  </p>
                </div>

                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                  <button
                    id="reshuffleBtn"
                    class="btn btn-outline btn-sm"
                    ${st.teamsLocked ? "disabled title='Tim sudah dikunci sejak Ronde 1'" : ""}
                  >🔀 Acak Ulang Grup</button>
                  <button id="addOneBotBtn" class="btn btn-outline btn-sm">🤖 +1 Bot</button>
                  <button id="addFourBotsBtn" class="btn btn-outline btn-sm">🤖 +4 Bot</button>
                  ${
                    st.players.some((p) => p.isBot)
                      ? `<button id="removeBotsBtn" class="btn btn-rose btn-sm">Hapus Bot</button>`
                      : ""
                  }
                  <button id="resetAllLobbyBtn" class="btn btn-rose btn-sm" title="Keluarkan (kick) semua pemain dari room dan reset dari awal">
                    🗑️ Reset Semua
                  </button>
                </div>
              </div>

              <div class="groups-grid" style="margin-bottom:20px;">
                ${groupsHtml}
              </div>

              <button id="startDrawingBtn" class="btn btn-emerald btn-lg">
                🚀 Mulai Ronde ${st.roundNumber} Menggambar (${st.players.length} Pemain)
              </button>
            </div>
          </div>
        </div>
      `;

      // Event Listeners GM di Lobby
      document.getElementById("copyInviteBtn").addEventListener("click", () => {
        navigator.clipboard.writeText(inviteUrl);
        showToast("Link undangan berhasil disalin!", "#10b981");
      });

      document.getElementById("setCustomUrlBtn").addEventListener("click", () => {
        const input = prompt(
          "Masukkan URL publik jika kamu menggunakan Tunnel/Hosting (kosongkan untuk deteksi otomatis):",
          client.customInviteUrl || inviteUrl
        );
        if (input !== null) {
          client.customInviteUrl = input.trim();
          localStorage.setItem(STORAGE_KEYS.CUSTOM_INVITE_URL, client.customInviteUrl);
          renderMainView();
        }
      });

      const triggerSettingsUpdate = async () => {
        const res = await sendAction("UPDATE_SETTINGS", {
          maxPlayers: Number(document.getElementById("settingMaxPlayers").value),
          groupCount: Number(document.getElementById("settingGroupCount").value),
          inkCapacityMode: document.getElementById("settingInkMode").value,
          turnDurationSeconds: Number(document.getElementById("settingTurnDuration").value),
          passInkBehavior: document.getElementById("settingPassBehavior").value,
          fuzzyMatching: document.getElementById("settingFuzzy").checked
        });
        if (!res.ok && res.error) {
          showToast(res.error, "#f43f5e");
        }
      };

      document.getElementById("settingMaxPlayers").addEventListener("change", triggerSettingsUpdate);
      document.getElementById("settingGroupCount").addEventListener("change", triggerSettingsUpdate);
      document.getElementById("settingInkMode").addEventListener("change", triggerSettingsUpdate);
      document.getElementById("settingTurnDuration").addEventListener("change", triggerSettingsUpdate);
      document.getElementById("settingPassBehavior").addEventListener("change", triggerSettingsUpdate);
      document.getElementById("settingFuzzy").addEventListener("change", triggerSettingsUpdate);

      document.getElementById("reshuffleBtn").addEventListener("click", async () => {
        const res = await sendAction("RESHUFFLE_GROUPS");
        if (res.ok) {
          showToast("Grup & urutan giliran berhasil diacak ulang!");
        } else {
          showToast(res.error || "Tidak dapat mengacak grup", "#f43f5e");
        }
      });

      document.getElementById("resetAllLobbyBtn").addEventListener("click", async () => {
        if (!confirm("Keluarkan (kick) semua orang dari room dan reset permainan ke awal?")) return;
        const res = await sendAction("KICK_ALL_PLAYERS");
        if (res.ok) {
          showToast("Semua orang telah dikeluarkan dari room & Lobby berhasil di-reset!", "#10b981");
        } else {
          showToast(res.error || "Gagal mereset room", "#f43f5e");
        }
      });

      document.getElementById("addOneBotBtn").addEventListener("click", () => {
        sendAction("ADD_BOT", { count: 1 });
      });

      document.getElementById("addFourBotsBtn").addEventListener("click", () => {
        sendAction("ADD_BOT", { count: 4 });
      });

      const removeBotsBtn = document.getElementById("removeBotsBtn");
      if (removeBotsBtn) {
        removeBotsBtn.addEventListener("click", () => {
          sendAction("REMOVE_BOTS");
        });
      }

      // Dropdown Pindah Grup Pemain
      document.querySelectorAll(".move-group-select").forEach((sel) => {
        sel.addEventListener("change", async () => {
          const playerId = sel.getAttribute("data-id");
          const targetGroupId = Number(sel.value);
          const res = await sendAction("MOVE_PLAYER_GROUP", { playerId, targetGroupId });
          if (res.ok) {
            showToast(`${res.playerName || "Pemain"} dipindahkan ke Grup ${targetGroupId}`, "#10b981");
          } else {
            showToast(res.error || "Gagal memindahkan pemain", "#f43f5e");
          }
        });
      });

      // Tombol Naik/Turun Urutan Giliran
      document.querySelectorAll(".move-order-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const playerId = btn.getAttribute("data-id");
          const direction = btn.getAttribute("data-dir");
          await sendAction("MOVE_PLAYER_ORDER", { playerId, direction });
        });
      });

      document.querySelectorAll(".kick-player-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const targetId = btn.getAttribute("data-id");
          const res = await sendAction("KICK_PLAYER", { playerId: targetId });
          if (res.ok) {
            showToast(
              `Pemain ${res.kickedName || ""} dikeluarkan dari Lobby`.trim(),
              "#f59e0b"
            );
          } else {
            showToast(res.error || "Gagal mengeluarkan pemain", "#f43f5e");
          }
        });
      });

      document.getElementById("openWordBankBtn").addEventListener("click", () => {
        const modal = document.getElementById("wordBankModal");
        const ta = document.getElementById("wordBankTextarea");
        ta.value = (st.customWords || []).join("\n");
        document.getElementById("wordBankCountInfo").textContent = `Total: ${(st.customWords || []).length} kata`;
        modal.classList.remove("hidden");
      });

      document.getElementById("startDrawingBtn").addEventListener("click", async () => {
        const res = await sendAction("START_DRAWING_PHASE");
        if (!res.ok) {
          showToast(res.error || "Gagal memulai ronde", "#f43f5e");
        } else {
          playTone(740, 0.2);
        }
      });
    } else {
      // Tampilan Player di Lobby
      const myGroup = me ? st.groups.find((g) => g.id === me.groupId) : null;
      const modeInfo = st.inkCapacityModes[st.settings.inkCapacityMode];

      container.innerHTML = `
        <div class="card" style="margin-bottom:18px;border-left:5px solid ${myGroup ? myGroup.color : "#6366f1"};">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div>
              <div style="font-size:0.82rem;color:var(--text-muted);">Status Pemain di Lobby</div>
              <h2 style="font-size:1.35rem;font-weight:800;">
                Halo, ${escapeHtml(me ? me.name : client.playerName)}! 👋
              </h2>
              ${
                myGroup && me
                  ? `<p style="font-size:0.95rem;margin-top:4px;">
                      Kamu berada di <strong style="color:${myGroup.color};">${escapeHtml(myGroup.fullName)}</strong> —
                      Urutan Menggambar ke-<strong>#${me.turnOrder}</strong>
                    </p>`
                  : `<p style="font-size:0.9rem;color:var(--text-muted);">Menunggu penempatan grup...</p>`
              }
            </div>
            <div style="text-align:right;font-size:0.82rem;color:var(--text-muted);">
              <div>Porsi Tinta: <strong>${st.settings.inkCapacityMode} (${modeInfo ? modeInfo.ink_per_player || modeInfo.total_group_ink : 2000} Tinta / Orang)</strong></div>
              <div>Waktu Giliran: <strong>${st.settings.turnDurationSeconds === 0 ? "♾️ Tanpa Batas Waktu" : `${st.settings.turnDurationSeconds} detik`}</strong></div>
              <div>Sisa Tinta Pass: <strong>${
                st.settings.passInkBehavior === "INHERITED"
                  ? "Diwariskan"
                  : st.settings.passInkBehavior === "WASTED"
                  ? "Hangus"
                  : "Ditabung ke Bonus Grup (Porsi Tetap)"
              }</strong></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <h3 style="font-size:1.1rem;">👥 Pembagian Grup &amp; Urutan Giliran Real-time (${st.players.length} Pemain)</h3>
            <span style="font-size:0.82rem;color:#a5b4fc;">⏳ Menunggu Game Master memulai ronde...</span>
          </div>
          <div class="groups-grid">
            ${groupsHtml}
          </div>
        </div>
      `;
    }
  }

  // ============================================================================
  // 2. FASE MENGGAMBAR ESTAFET (STEP 2: DRAWING)
  // ============================================================================
  function renderDrawingView(container, st) {
    if (client.role === "game_master") {
      renderGMDrawingMonitor(container, st);
      return;
    }

    const me = st.players.find((p) => p.id === client.playerId);
    const myGroup = me ? st.groups.find((g) => g.id === me.groupId) : st.groups[0];

    if (!myGroup) {
      container.innerHTML = `<div class="card">Kamu belum tergabung dalam grup.</div>`;
      return;
    }

    const isMyTurn = myGroup.status === "DRAWING" && myGroup.activePlayerId === client.playerId;
    const isMyCountdown = myGroup.status === "COUNTDOWN" && myGroup.activePlayerId === client.playerId;
    const turnPct =
      myGroup.turnInkLimit > 0
        ? Math.round((Math.max(0, myGroup.turnInkRemaining) / myGroup.turnInkLimit) * 100)
        : 0;

    container.innerHTML = `
      <div class="grid-sidebar canvas-first-mobile">
        <!-- Info Grup, Kata Rahasia & Urutan Giliran -->
        <div style="display:flex;flex-direction:column;gap:14px;">
          <div class="card" style="border-top:4px solid ${myGroup.color};">
            <div style="font-size:0.78rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">
              Kata Objek Rahasia ${escapeHtml(myGroup.name)}
            </div>
            <div style="font-size:1.75rem;font-weight:900;color:#fde68a;margin:4px 0 8px;">
              🎯 ${escapeHtml(myGroup.secretWord)}
            </div>
            <p style="font-size:0.8rem;color:var(--text-muted);">
              Jangan sebutkan kata ini keras-keras! Gambarlah secara estafet bersama teman satu grupmu.
            </p>
          </div>

          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <h3 style="font-size:0.95rem;">⏱️ Status Giliran</h3>
              <span id="turnTimerBadge" class="pill phase-pill" style="font-size:0.9rem;">
                ${
                  myGroup.status === "FINISHED"
                    ? "Selesai"
                    : myGroup.status === "COUNTDOWN"
                    ? `Siap-siap: ${myGroup.countdownRemainingSec}d`
                    : st.settings.turnDurationSeconds === 0 || myGroup.turnRemainingSec === null
                    ? "♾️ Tanpa Batas Waktu"
                    : `${myGroup.turnRemainingSec} detik`
                }
              </span>
            </div>

            <div class="ink-meter-container">
              <div>
                <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:4px;">
                  <span>🧪 Sisa Total Tinta Grup (Bonus Skor)</span>
                  <strong id="groupInkText-${myGroup.id}">${myGroup.remainingInk} / ${myGroup.initialInk} (${myGroup.remainingInkPct}%)</strong>
                </div>
                <div class="ink-bar-track">
                  <div id="groupInkBar-${myGroup.id}" class="ink-bar-fill group-ink" style="width:${myGroup.remainingInkPct}%;"></div>
                </div>
              </div>
            </div>

            <h4 style="font-size:0.82rem;color:var(--text-muted);margin:12px 0 8px;">Urutan Estafet ${escapeHtml(myGroup.name)}:</h4>
            <ul class="member-list">
              ${myGroup.members
                .map((m, idx) => {
                  const isCurrent = idx === myGroup.currentTurnIndex && myGroup.status !== "FINISHED";
                  const isDone = idx < myGroup.currentTurnIndex || myGroup.status === "FINISHED";
                  return `
                    <li class="member-item ${isCurrent ? "is-active-turn" : ""}">
                      <div>
                        <span class="turn-badge">#${m.turnOrder}</span>
                        <span>${escapeHtml(m.name)} ${m.id === client.playerId ? "(Kamu)" : ""}</span>
                      </div>
                      <span style="font-size:0.76rem;font-weight:700;">
                        ${isDone ? "✅ Selesai" : isCurrent ? "🎨 Menggambar..." : "⏳ Menunggu"}
                      </span>
                    </li>
                  `;
                })
                .join("")}
            </ul>
          </div>
        </div>

        <!-- Area Kanvas & Toolbar -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
              <span class="mobile-only-word-pill">🎯 ${escapeHtml(myGroup.secretWord)}</span>
              <strong style="font-size:1.05rem;">
                ${
                  myGroup.status === "FINISHED"
                    ? "✅ Grup Kamu Sudah Selesai Menggambar!"
                    : isMyTurn
                    ? "🟢 GILIRAN KAMU MENGGAMBAR SEKARANG!"
                    : `👀 Sedang Menggambar: ${escapeHtml(myGroup.activePlayerName || "-")} (Live Open Relay)`
                }
              </strong>
            </div>
            ${
              isMyTurn
                ? `<button id="passTurnBtn" class="btn btn-amber btn-sm">⏭️ Pass / Selesai Giliran</button>`
                : ""
            }
          </div>

          <div class="canvas-wrapper">
            <canvas
              id="groupCanvas-${myGroup.id}"
              class="drawing-canvas ${isMyTurn ? "" : "readonly"}"
              width="800"
              height="500"
            ></canvas>

            ${
              myGroup.status === "COUNTDOWN"
                ? `<div id="countdownOverlay" class="canvas-overlay">
                    <div style="font-size:0.9rem;color:#cbd5e1;margin-bottom:4px;">Giliran Berikutnya</div>
                    <div style="font-size:1.6rem;font-weight:900;color:#fde68a;margin-bottom:8px;">
                      ${escapeHtml(myGroup.activePlayerName || "")} ${isMyCountdown ? "(KAMU!)" : ""}
                    </div>
                    <div id="countdownNumber" style="font-size:3.2rem;font-weight:900;color:#fff;">
                      ${myGroup.countdownRemainingSec}
                    </div>
                    <p style="font-size:0.85rem;color:var(--text-muted);margin-top:6px;">
                      Kata Rahasia: <strong style="color:#fff;">${escapeHtml(myGroup.secretWord)}</strong>
                    </p>
                  </div>`
                : ""
            }

            ${
              myGroup.status === "FINISHED"
                ? `<div class="canvas-overlay" style="background:rgba(15,23,42,0.55);">
                    <div style="font-size:2rem;margin-bottom:6px;">🎉</div>
                    <h3 style="font-size:1.3rem;margin-bottom:4px;">Gambar ${escapeHtml(myGroup.name)} Selesai!</h3>
                    <p style="font-size:0.88rem;color:#cbd5e1;">
                      Sisa Tinta Grup: <strong>${myGroup.remainingInkPct}%</strong> (+${myGroup.remainingInkPct} Poin Bonus jika minimal 1 orang menebak benar).<br/>
                      Menunggu grup lain menyelesaikan gambarnya...
                    </p>
                  </div>`
                : ""
            }
          </div>

          <!-- Bar Sisa Tinta Individu Peserta Tepat di Bawah Kanvas -->
          <div style="margin-top:12px;padding:10px 12px;background:rgba(15,23,42,0.65);border-radius:var(--radius-md);border:1px solid var(--border-color);">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.8rem;margin-bottom:6px;gap:8px;flex-wrap:wrap;">
              <span>🖌️ Porsi Tinta Giliran Ini (${
                st.settings.passInkBehavior === "INHERITED"
                  ? "Warisan Aktif"
                  : st.settings.passInkBehavior === "WASTED"
                  ? "Hangus Jika Pass"
                  : "Porsi Tetap • Sisa Ditabung"
              })</span>
              <strong id="turnInkText-${myGroup.id}">${myGroup.turnInkRemaining} / ${myGroup.turnInkLimit} (${turnPct}%)</strong>
            </div>
            <div class="ink-bar-track">
              <div id="turnInkBar-${myGroup.id}" class="ink-bar-fill turn-ink ${turnPct < 20 ? "danger" : ""}" style="width:${turnPct}%;"></div>
            </div>
          </div>

          <!-- Toolbar Warna, Penghapus & Ukuran Kuas (Tanpa Tombol Undo sesuai Blueprint) -->
          <div class="toolbar">
            <div class="color-swatches">
              ${st.drawingTools.colors
                .map(
                  (col) => `
                  <button
                    type="button"
                    class="color-swatch ${!client.isEraser && client.selectedColor === col ? "active" : ""}"
                    data-color="${col}"
                    style="background:${col};"
                    ${!isMyTurn ? "disabled" : ""}
                    title="Warna ${col}"
                  ></button>
                `
                )
                .join("")}
              <button
                type="button"
                id="eraserToolBtn"
                class="brush-btn ${client.isEraser ? "active" : ""}"
                ${!isMyTurn ? "disabled" : ""}
                title="Penghapus (Tidak mengurangi & tidak mengembalikan tinta)"
              >
                🧽 Penghapus (0x tinta)
              </button>
            </div>

            <div class="brush-buttons">
              ${st.drawingTools.brush_sizes
                .map(
                  (b) => `
                  <button
                    type="button"
                    class="brush-btn brush-size-btn ${client.selectedBrushSize === b.size ? "active" : ""}"
                    data-size="${b.size}"
                    ${!isMyTurn ? "disabled" : ""}
                  >
                    <span style="width:${Math.min(14, b.size + 2)}px;height:${Math.min(14, b.size + 2)}px;border-radius:50%;background:#fff;display:inline-block;"></span>
                    <span>${escapeHtml(b.label)} (${b.ink_multiplier}x tinta)</span>
                  </button>
                `
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>
    `;

    const canvas = document.getElementById(`groupCanvas-${myGroup.id}`);
    renderAllStrokesOnCanvas(canvas, myGroup.strokes);

    if (isMyTurn) {
      playTone(680, 0.14);
      bindInteractiveCanvas(canvas, myGroup.id);

      const eraserBtn = document.getElementById("eraserToolBtn");

      document.querySelectorAll(".color-swatch").forEach((btn) => {
        btn.addEventListener("click", () => {
          client.isEraser = false;
          client.selectedColor = btn.getAttribute("data-color");
          document.querySelectorAll(".color-swatch").forEach((el) => el.classList.remove("active"));
          if (eraserBtn) eraserBtn.classList.remove("active");
          btn.classList.add("active");
        });
      });

      if (eraserBtn) {
        eraserBtn.addEventListener("click", () => {
          client.isEraser = true;
          document.querySelectorAll(".color-swatch").forEach((el) => el.classList.remove("active"));
          eraserBtn.classList.add("active");
        });
      }

      document.querySelectorAll(".brush-size-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          client.selectedBrushSize = Number(btn.getAttribute("data-size"));
          document.querySelectorAll(".brush-size-btn").forEach((el) => el.classList.remove("active"));
          btn.classList.add("active");
        });
      });

      const passBtn = document.getElementById("passTurnBtn");
      if (passBtn) {
        passBtn.addEventListener("click", () => {
          playTone(440, 0.1);
          sendAction("PASS_TURN", { groupId: myGroup.id, playerId: client.playerId });
        });
      }
    }
  }

  function renderGMDrawingMonitor(container, st) {
    const cardsHtml = st.groups
      .map((g) => {
        const turnTimeLabel =
          st.settings.turnDurationSeconds === 0 || g.turnRemainingSec === null
            ? "♾️ Tanpa Batas Waktu"
            : `${g.turnRemainingSec}d`;
        return `
          <div class="card" style="padding:14px;border-top:4px solid ${g.color};">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <strong>${escapeHtml(g.fullName)}</strong>
              <span id="gmGroupStatusPill-${g.id}" class="pill" style="font-size:0.75rem;">
                ${
                  g.status === "FINISHED"
                    ? "✅ Selesai"
                    : g.status === "COUNTDOWN"
                    ? `⏳ Siap (${g.countdownRemainingSec}d): ${escapeHtml(g.activePlayerName || "-")}`
                    : `🎨 ${escapeHtml(g.activePlayerName || "-")} (${turnTimeLabel})`
                }
              </span>
            </div>

            <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:8px;display:flex;justify-content:space-between;">
              <span>Kata Objek: <strong style="color:#fde68a;">${client.gmShowSecretWords ? escapeHtml(g.secretWord) : "•••••• (Disembunyikan)"}</strong></span>
              <span id="groupInkText-${g.id}">${g.remainingInk} / ${g.initialInk} (${g.remainingInkPct}%)</span>
            </div>

            <div class="canvas-wrapper" style="margin-bottom:8px;">
              <canvas id="groupCanvas-${g.id}" class="drawing-canvas readonly" width="800" height="500"></canvas>
            </div>

            ${
              g.status !== "FINISHED"
                ? `<div style="display:flex;justify-content:flex-end;">
                    <button
                      type="button"
                      class="btn btn-amber btn-sm gm-skip-turn-btn"
                      data-group-id="${g.id}"
                      data-player-name="${escapeHtml(g.activePlayerName || "Pemain")}"
                      title="Lewati giliran pemain yang sedang aktif di grup ini"
                    >
                      ⏭️ Skip Giliran ${escapeHtml(g.activePlayerName || "Pemain")}
                    </button>
                  </div>`
                : ""
            }
          </div>
        `;
      })
      .join("");

    container.innerHTML = `
      <div class="card" style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
        <div>
          <h2 style="font-size:1.25rem;font-weight:800;">📡 Monitor Live Menggambar Seluruh Grup</h2>
          <p style="font-size:0.82rem;color:var(--text-muted);">
            Kata rahasia disembunyikan secara default agar aman ditampilkan di layar proyektor.
          </p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button id="toggleGmWordsBtn" class="btn btn-outline btn-sm">
            ${client.gmShowSecretWords ? "🙈 Sembunyikan Kata Rahasia" : "👁️ Intip Kata Rahasia"}
          </button>
          <button id="forceFinishDrawingBtn" class="btn btn-rose btn-sm">
            ⏹️ Force Finish Semua Grup
          </button>
        </div>
      </div>

      <div class="grid-2">
        ${cardsHtml}
      </div>
    `;

    st.groups.forEach((g) => {
      const c = document.getElementById(`groupCanvas-${g.id}`);
      renderAllStrokesOnCanvas(c, g.strokes);
    });

    document.getElementById("toggleGmWordsBtn").addEventListener("click", () => {
      client.gmShowSecretWords = !client.gmShowSecretWords;
      renderMainView();
    });

    document.getElementById("forceFinishDrawingBtn").addEventListener("click", () => {
      sendAction("FORCE_FINISH_DRAWING");
    });

    document.querySelectorAll(".gm-skip-turn-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const groupId = Number(btn.getAttribute("data-group-id"));
        const res = await sendAction("GM_SKIP_MEMBER_TURN", { groupId });
        if (res.ok) {
          playTone(480, 0.14);
          showToast(
            `⏭️ Giliran ${res.skippedName} di ${res.groupName} dilewati oleh Admin`,
            "#f59e0b"
          );
        } else {
          showToast(res.error || "Gagal melewati giliran", "#f43f5e");
        }
      });
    });
  }

  function updateDrawingTimersDOM() {
    const st = client.state;
    if (!st || st.phase !== "DRAWING") return;

    const estServerNow = Date.now() + (client.serverTimeOffset || 0);
    st.groups.forEach((g) => {
      if (g.status === "COUNTDOWN" && g.countdownEndAt) {
        g.countdownRemainingSec = Math.max(0, Math.ceil((g.countdownEndAt - estServerNow) / 1000));
      } else if (
        g.status === "DRAWING" &&
        st.settings.turnDurationSeconds > 0 &&
        g.turnEndAt > 0
      ) {
        g.turnRemainingSec = Math.max(0, Math.ceil((g.turnEndAt - estServerNow) / 1000));
      }
    });

    if (client.role === "game_master") {
      st.groups.forEach((g) => {
        const pill = document.getElementById(`gmGroupStatusPill-${g.id}`);
        if (!pill) return;
        const turnTimeLabel =
          st.settings.turnDurationSeconds === 0 || g.turnRemainingSec === null
            ? "♾️ Tanpa Batas Waktu"
            : `${g.turnRemainingSec}d`;
        pill.textContent =
          g.status === "FINISHED"
            ? "✅ Selesai"
            : g.status === "COUNTDOWN"
            ? `⏳ Siap (${g.countdownRemainingSec}d): ${g.activePlayerName || "-"}`
            : `🎨 ${g.activePlayerName || "-"} (${turnTimeLabel})`;
      });
      return;
    }

    const me = st.players.find((p) => p.id === client.playerId);
    const myGroup = me ? st.groups.find((g) => g.id === me.groupId) : null;
    if (!myGroup) return;

    const timerBadge = document.getElementById("turnTimerBadge");
    if (timerBadge) {
      timerBadge.textContent =
        myGroup.status === "FINISHED"
          ? "Selesai"
          : myGroup.status === "COUNTDOWN"
          ? `Siap-siap: ${myGroup.countdownRemainingSec}d`
          : st.settings.turnDurationSeconds === 0 || myGroup.turnRemainingSec === null
          ? "♾️ Tanpa Batas Waktu"
          : `${myGroup.turnRemainingSec} detik`;
    }

    const countdownNumber = document.getElementById("countdownNumber");
    if (countdownNumber) {
      countdownNumber.textContent = String(myGroup.countdownRemainingSec);
    }
  }

  function updateDrawingViewInPlace() {
    const st = client.state;
    if (!st) return;

    updateDrawingTimersDOM();

    if (client.role === "game_master") {
      st.groups.forEach((g) => {
        updateInkMetersDOM(g.id);
      });
      return;
    }

    const me = st.players.find((p) => p.id === client.playerId);
    const myGroup = me ? st.groups.find((g) => g.id === me.groupId) : null;
    if (!myGroup) return;

    updateInkMetersDOM(myGroup.id);
  }

  // Binding event Mouse & Touch pada Canvas untuk menggambar secara halus
  function bindInteractiveCanvas(canvas, groupId) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    function getCanvasCoords(ev) {
      const rect = canvas.getBoundingClientRect();
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
      };
    }

    function onStart(ev) {
      ev.preventDefault();
      client.isDrawingPointerDown = true;
      client.lastPoint = getCanvasCoords(ev);
    }

    function onMove(ev) {
      if (!client.isDrawingPointerDown || !client.lastPoint) return;
      ev.preventDefault();
      const pt = getCanvasCoords(ev);
      const dist = Math.hypot(pt.x - client.lastPoint.x, pt.y - client.lastPoint.y);
      if (dist < 2) return;

      const segment = {
        x1: client.lastPoint.x,
        y1: client.lastPoint.y,
        x2: pt.x,
        y2: pt.y,
        color: client.isEraser ? "#FFFFFF" : client.selectedColor,
        size: client.selectedBrushSize,
        isEraser: client.isEraser
      };

      drawSegmentOnCanvas(ctx, segment);
      sendStrokeSegmentWS(groupId, segment);
      client.lastPoint = pt;
    }

    function onEnd() {
      client.isDrawingPointerDown = false;
      client.lastPoint = null;
    }

    canvas.addEventListener("mousedown", onStart);
    canvas.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);

    canvas.addEventListener("touchstart", onStart, { passive: false });
    canvas.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
  }

  // ============================================================================
  // 3. FASE SIAP MENEBAK (STEP 3: READY_TO_GUESS)
  // ============================================================================
  function renderReadyToGuessView(container, st) {
    const isGM = client.role === "game_master";

    container.innerHTML = `
      <div style="max-width:640px;margin:32px auto;">
        <div class="card" style="text-align:center;padding:36px 24px;">
          <div style="font-size:3.2rem;margin-bottom:12px;">🎨✨</div>
          <h2 style="font-size:1.6rem;font-weight:800;margin-bottom:8px;">
            Seluruh Grup Selesai Menggambar!
          </h2>
          <p style="color:var(--text-muted);font-size:0.95rem;margin-bottom:24px;">
            Saatnya memasuki sesi menebak karya tiap grup satu per satu.<br/>
            Penebak tercepat mendapat <strong>+30 poin</strong> (turun 3 poin tiap urutan berikutnya hingga minimal <strong>+5 poin</strong>) untuk grupnya, dan <strong>+100 poin</strong> untuk grup penggambar!
          </p>

          <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-bottom:24px;">
            ${st.groups
              .map(
                (g) => `
                <div class="pill" style="border-color:${g.color};">
                  <span class="group-dot" style="background:${g.color};"></span>
                  <span>${escapeHtml(g.name)} — Sisa Tinta: ${g.remainingInkPct}%</span>
                </div>
              `
              )
              .join("")}
          </div>

          ${
            isGM
              ? `<button id="startGuessingPhaseBtn" class="btn btn-emerald btn-lg">
                  ➡️ Next: Masuk Menu Menebak (Mulai Grup 1)
                </button>`
              : `<div class="pill phase-pill" style="padding:10px 18px;font-size:0.9rem;">
                  ⏳ Menunggu komando Game Master untuk menampilkan Gambar Grup 1...
                </div>`
          }
        </div>
      </div>
    `;

    if (isGM) {
      document.getElementById("startGuessingPhaseBtn").addEventListener("click", () => {
        playTone(620, 0.16);
        sendAction("START_GUESSING_PHASE");
      });
    }
  }

  // ============================================================================
  // 4. FASE MENEBAK GAMBAR (STEP 4: GUESSING)
  // ============================================================================
  function renderClueBannerHTML(targetGroup) {
    if (!targetGroup || !targetGroup.clueText) return "";
    return `
      <div class="card" style="background:rgba(245,158,11,0.16);border:1px solid rgba(245,158,11,0.5);text-align:center;padding:12px 16px;">
        <div style="font-size:0.78rem;color:#fde68a;text-transform:uppercase;font-weight:700;letter-spacing:0.06em;">
          💡 Clue dari Game Master (${targetGroup.clueLength || ""} Huruf)
        </div>
        <div style="font-size:1.75rem;font-weight:900;letter-spacing:0.18em;color:#ffffff;font-family:monospace;margin-top:4px;">
          ${escapeHtml(targetGroup.clueText)}
        </div>
      </div>
    `;
  }

  function renderGMClueControlsHTML(st, targetGroup) {
    const revealed =
      (targetGroup && targetGroup.clueRevealedCount) || st.clueRevealedCount || 1;
    const maxLetters = (targetGroup && targetGroup.clueMaxLetters) || 1;
    const isMaxed = revealed >= maxLetters;

    return `
      <button id="toggleClueBtn" class="btn btn-outline" style="width:100%;">
        ${
          st.clueActive
            ? "🙈 Sembunyikan Clue dari Semua Orang"
            : "💡 Tampilkan Clue (1 Huruf Awal + _ _ _)"
        }
      </button>
      ${
        st.clueActive
          ? `<button
              id="addClueLetterBtn"
              class="btn btn-outline"
              style="width:100%;border-color:rgba(245,158,11,0.55);color:#fde68a;"
              ${isMaxed ? "disabled" : ""}
            >
              ${
                isMaxed
                  ? `✅ Maksimal Clue Tercapai (${revealed}/${maxLetters} Huruf)`
                  : `➕ Tambah +1 Huruf Clue (${revealed}/${maxLetters} Huruf)`
              }
            </button>`
          : ""
      }
    `;
  }

  function bindGMClueEvents() {
    const toggleClueBtn = document.getElementById("toggleClueBtn");
    if (toggleClueBtn) {
      toggleClueBtn.addEventListener("click", () => {
        playTone(620, 0.14);
        sendAction("TOGGLE_CLUE");
      });
    }
    const addClueLetterBtn = document.getElementById("addClueLetterBtn");
    if (addClueLetterBtn) {
      addClueLetterBtn.addEventListener("click", () => {
        playTone(680, 0.14);
        sendAction("ADD_CLUE_LETTER");
      });
    }
  }

  function renderGuessingView(container, st) {
    const isGM = client.role === "game_master";
    const targetGroup = st.groups[st.activeGuessGroupIndex] || st.groups[0];
    const me = st.players.find((p) => p.id === client.playerId);
    const isDrawerGroupMember = me && me.groupId === targetGroup.id;
    const myCorrectEntry = me
      ? targetGroup.correctGuessers.find((cg) => cg.playerId === me.id)
      : null;
    const nextGuessPoints = Math.max(5, 30 - targetGroup.correctGuessers.length * 3);

    container.innerHTML = `
      <div class="grid-sidebar canvas-first-mobile">
        <!-- Panel Kiri: Input Tebakan & Live Feed -->
        <div style="display:flex;flex-direction:column;gap:14px;">
          <div class="card" style="border-top:4px solid ${targetGroup.color};">
            <div style="font-size:0.78rem;color:var(--text-muted);text-transform:uppercase;">
              Giliran Tebak Karya (${st.activeGuessGroupIndex + 1} dari ${st.groups.length})
            </div>
            <h2 style="font-size:1.4rem;font-weight:800;margin:4px 0;">
              🖼️ Hasil Gambar ${escapeHtml(targetGroup.fullName)}
            </h2>
            <p style="font-size:0.84rem;color:var(--text-muted);">
              Sisa Tinta Grup: <strong>${targetGroup.remainingInkPct}%</strong> •
              Penebak Benar Saat Ini: <strong id="correctCountBadge">${targetGroup.correctGuessers.length} orang</strong>
            </p>
          </div>

          <div id="clueBannerArea">
            ${renderClueBannerHTML(targetGroup)}
          </div>

          ${
            isGM
              ? `<div class="card">
                  <h3 style="font-size:1rem;margin-bottom:8px;">👑 Kontrol Game Master</h3>
                  <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:14px;">
                    Berikan waktu bagi anggota grup lain untuk mengetik tebakan mereka. Kamu juga bisa menampilkan, menambah huruf, atau menyembunyikan Clue.
                  </p>
                  <div style="display:flex;flex-direction:column;gap:10px;">
                    <div id="gmClueControlsArea" style="display:flex;flex-direction:column;gap:10px;">
                      ${renderGMClueControlsHTML(st, targetGroup)}
                    </div>
                    <button id="revealAnswerBtn" class="btn btn-amber btn-lg">
                      🔓 Tampilkan Jawaban Asli (Reveal)
                    </button>
                  </div>
                </div>`
              : isDrawerGroupMember
              ? `<div class="card" style="background:rgba(99,102,241,0.14);border-color:rgba(99,102,241,0.4);">
                  <h3 style="font-size:1rem;margin-bottom:4px;">🤫 Ini Gambar Grup Kamu!</h3>
                  <p style="font-size:0.85rem;color:#cbd5e1;">
                    Anggota ${escapeHtml(targetGroup.name)} hanya menonton di sesi ini. Jangan bocorkan jawabannya! Setiap pemain grup lain yang berhasil menebak memberi grupmu <strong>+100 poin</strong>!
                  </p>
                </div>`
              : `<div class="card">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <h3 style="font-size:1rem;">⚡ Ketik Tebakan Tercepat!</h3>
                    <span id="nextPointsBadge" class="pill" style="font-size:0.76rem;color:#fde68a;">
                      Poin Saat Ini: +${nextGuessPoints} Poin
                    </span>
                  </div>
                  <div id="guessBoxArea">
                    ${renderGuessInputAreaHTML(myCorrectEntry)}
                  </div>
                </div>`
          }

          <div class="card" style="flex:1;">
            <h3 style="font-size:0.95rem;margin-bottom:10px;">💬 Live Log Tebakan Pemain</h3>
            <div id="guessFeedContainer" class="guess-feed">
              ${renderGuessFeedItemsHTML(st.guessFeed)}
            </div>
          </div>
        </div>

        <!-- Panel Kanan: Kanvas Hasil Gambar Grup [X] -->
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <strong>Kanvas Estafet ${escapeHtml(targetGroup.fullName)}</strong>
            <span style="font-size:0.82rem;color:var(--text-muted);">
              Digambar oleh: ${targetGroup.members.map((m) => escapeHtml(m.name)).join(" ➔ ")}
            </span>
          </div>
          <div class="canvas-wrapper">
            <canvas id="guessCanvas" class="drawing-canvas readonly" width="800" height="500"></canvas>
          </div>
        </div>
      </div>
    `;

    const guessCanvas = document.getElementById("guessCanvas");
    renderAllStrokesOnCanvas(guessCanvas, targetGroup.strokes);

    bindGuessFormEvents();

    if (isGM) {
      bindGMClueEvents();
      document.getElementById("revealAnswerBtn").addEventListener("click", () => {
        playTone(780, 0.22);
        sendAction("REVEAL_CURRENT_GROUP");
      });
    }
  }

  function renderGuessInputAreaHTML(myCorrectEntry) {
    if (myCorrectEntry) {
      const pts = typeof myCorrectEntry.points === "number" ? myCorrectEntry.points : 30;
      const rnk = myCorrectEntry.rank || 1;
      return `
        <div style="padding:14px;border-radius:12px;background:rgba(16,185,129,0.2);border:1px solid rgba(16,185,129,0.5);color:#a7f3d0;font-weight:700;text-align:center;">
          🎉 Kamu sudah berhasil menebak gambar ini! (Tercepat #${rnk} • +${pts} Poin untuk grupmu)
        </div>
      `;
    }
    return `
      <form id="submitGuessForm" style="display:flex;gap:8px;">
        <input
          id="guessTextInput"
          type="text"
          class="input-field"
          placeholder="Tebak 1 kata objek gambar ini..."
          autocomplete="off"
          required
        />
        <button type="submit" class="btn btn-emerald">Kirim</button>
      </form>
      <div id="guessHintMsg" style="font-size:0.84rem;margin-top:8px;min-height:20px;font-weight:700;"></div>
    `;
  }

  function renderGuessFeedItemsHTML(feed) {
    if (!feed || feed.length === 0) {
      return `<div style="color:var(--text-muted);font-size:0.84rem;text-align:center;padding:20px;">Belum ada tebakan masuk...</div>`;
    }
    return feed
      .map((item) => {
        return `
          <div class="guess-item ${item.isCorrect ? "correct" : item.isClose ? "close" : ""}">
            <span style="font-weight:700;">${escapeHtml(item.playerName)} (Grup ${item.groupId}):</span>
            <span>${escapeHtml(item.text)}</span>
            ${
              item.isClose
                ? `<span style="font-size:0.74rem;color:#fde68a;font-weight:700;margin-left:6px;">🔥 Mendekati! (Hanya terlihat olehmu)</span>`
                : ""
            }
          </div>
        `;
      })
      .join("");
  }

  function bindGuessFormEvents() {
    const form = document.getElementById("submitGuessForm");
    if (!form) return;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("guessTextInput");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";

      const res = await sendAction("SUBMIT_GUESS", {
        playerId: client.playerId,
        text
      });

      const hintEl = document.getElementById("guessHintMsg");
      if (res.isCorrect) {
        playTone(880, 0.25);
        showToast(
          `🎉 Tebakanmu BENAR! Tercepat #${res.rank || 1} (+${res.pointsEarned || 30} Poin untuk grupmu!)`,
          "#10b981"
        );
      } else if (res.isClose) {
        playTone(580, 0.18);
        showToast(
          `🔥 Hampir benar! Jawabanmu "${text}" sudah sangat mendekati! (Cukup 1 kata)`,
          "#f59e0b"
        );
        if (hintEl) {
          hintEl.style.color = "#fde68a";
          hintEl.textContent = `🔥 Hampir benar! Jawabanmu ("${text}") sudah mendekati — cukup ketik 1 kata utamanya & cek ejaanmu! (Hanya terlihat olehmu)`;
        }
      } else if (hintEl) {
        hintEl.style.color = "#f87171";
        hintEl.textContent = "❌ Belum tepat, coba tebak lagi!";
      }
    });
  }

  function updateGuessingViewInPlace() {
    const st = client.state;
    if (!st) return;
    const targetGroup = st.groups[st.activeGuessGroupIndex] || st.groups[0];
    const me = st.players.find((p) => p.id === client.playerId);
    const myCorrectEntry = me
      ? targetGroup.correctGuessers.find((cg) => cg.playerId === me.id)
      : null;
    const nextGuessPoints = Math.max(5, 30 - targetGroup.correctGuessers.length * 3);

    const badge = document.getElementById("correctCountBadge");
    if (badge) {
      badge.textContent = `${targetGroup.correctGuessers.length} orang`;
    }

    const clueBannerArea = document.getElementById("clueBannerArea");
    if (clueBannerArea) {
      clueBannerArea.innerHTML = renderClueBannerHTML(targetGroup);
    }

    const gmClueControlsArea = document.getElementById("gmClueControlsArea");
    if (gmClueControlsArea) {
      gmClueControlsArea.innerHTML = renderGMClueControlsHTML(st, targetGroup);
      bindGMClueEvents();
    }

    const nextPtsBadge = document.getElementById("nextPointsBadge");
    if (nextPtsBadge) {
      nextPtsBadge.textContent = `Poin Saat Ini: +${nextGuessPoints} Poin`;
    }

    const feedContainer = document.getElementById("guessFeedContainer");
    if (feedContainer) {
      feedContainer.innerHTML = renderGuessFeedItemsHTML(st.guessFeed);
    }

    const guessBoxArea = document.getElementById("guessBoxArea");
    if (guessBoxArea && myCorrectEntry && document.getElementById("submitGuessForm")) {
      guessBoxArea.innerHTML = renderGuessInputAreaHTML(myCorrectEntry);
    }
  }

  // ============================================================================
  // 5. FASE REVEAL JAWABAN (STEP 5: REVEAL)
  // ============================================================================
  function renderRevealView(container, st) {
    const isGM = client.role === "game_master";
    const targetGroup = st.groups[st.activeGuessGroupIndex] || st.groups[0];
    const correctCount = targetGroup.correctGuessers.length;
    const drawerPoints = correctCount * 100;
    const inkBonus = correctCount >= 1 ? targetGroup.remainingInkPct : 0;
    const totalGroupEarned = drawerPoints + inkBonus;
    const hasNextGroup = st.activeGuessGroupIndex + 1 < st.groups.length;

    container.innerHTML = `
      <div class="grid-sidebar">
        <div style="display:flex;flex-direction:column;gap:14px;">
          <div class="card" style="border-top:4px solid ${targetGroup.color};text-align:center;">
            <div style="font-size:0.8rem;color:var(--text-muted);text-transform:uppercase;">
              Jawaban Asli Gambar ${escapeHtml(targetGroup.fullName)}
            </div>
            <div style="font-size:2.2rem;font-weight:900;color:#fde68a;margin:8px 0;">
              ✨ ${escapeHtml(targetGroup.secretWord)} ✨
            </div>
          </div>

          <div class="card">
            <h3 style="font-size:1rem;margin-bottom:12px;">📊 Rincian Poin ${escapeHtml(targetGroup.name)}</h3>

            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-color);font-size:0.9rem;">
              <span>Poin Penggambar (+100 × ${correctCount} penebak)</span>
              <strong style="color:#38bdf8;">+${drawerPoints} Poin</strong>
            </div>

            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-color);font-size:0.9rem;">
              <span>Bonus Sisa Tinta (${targetGroup.remainingInkPct}% sisa tinta)</span>
              <strong style="color:#10b981;">
                +${inkBonus} Poin
                ${correctCount === 0 ? `<span style="font-size:0.75rem;color:#f87171;">(Syarat min. 1 penebak)</span>` : ""}
              </strong>
            </div>

            <div style="display:flex;justify-content:space-between;padding:10px 0 4px;font-size:1.05rem;">
              <strong>Total Poin Gambar Ini</strong>
              <strong style="color:#fde68a;">+${totalGroupEarned} Poin</strong>
            </div>
          </div>

          <div class="card">
            <h3 style="font-size:0.95rem;margin-bottom:10px;">
              ⚡ Urutan Penebak Tercepat (+30 s/d +5 Poin)
            </h3>
            ${
              correctCount === 0
                ? `<p style="font-size:0.85rem;color:var(--text-muted);">Tidak ada pemain dari grup lain yang berhasil menebak.</p>`
                : `<ul class="member-list">
                    ${targetGroup.correctGuessers
                      .map((cg, idx) => {
                        const rnk = cg.rank || idx + 1;
                        const pts = typeof cg.points === "number" ? cg.points : Math.max(5, 30 - idx * 3);
                        return `
                          <li class="member-item">
                            <span>
                              <span class="turn-badge">#${rnk}</span>
                              <strong>${escapeHtml(cg.playerName)}</strong> (Grup ${cg.groupId})
                            </span>
                            <span style="color:#10b981;font-weight:700;">+${pts} Poin</span>
                          </li>
                        `;
                      })
                      .join("")}
                  </ul>`
            }
          </div>

          ${
            isGM
              ? hasNextGroup
                ? `<button id="nextGuessGroupBtn" class="btn btn-emerald btn-lg">
                    ➡️ Next: Tampilkan Gambar Grup ${st.activeGuessGroupIndex + 2}
                  </button>`
                : `<button id="showLeaderboardBtn" class="btn btn-amber btn-lg">
                    🏆 Tampilkan Hasil Skor &amp; Leaderboard Akhir
                  </button>`
              : `<div class="pill phase-pill" style="justify-content:center;padding:12px;">
                  ⏳ Menunggu Game Master melanjutkan...
                </div>`
          }
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <strong>Karya ${escapeHtml(targetGroup.fullName)} — "${escapeHtml(targetGroup.secretWord)}"</strong>
            <span style="font-size:0.82rem;color:var(--text-muted);">Sisa Tinta: ${targetGroup.remainingInkPct}%</span>
          </div>
          <div class="canvas-wrapper">
            <canvas id="revealCanvas" class="drawing-canvas readonly" width="800" height="500"></canvas>
          </div>
        </div>
      </div>
    `;

    const revealCanvas = document.getElementById("revealCanvas");
    renderAllStrokesOnCanvas(revealCanvas, targetGroup.strokes);

    if (isGM) {
      const nextBtn = document.getElementById("nextGuessGroupBtn");
      if (nextBtn) {
        nextBtn.addEventListener("click", () => {
          playTone(640, 0.16);
          sendAction("NEXT_GUESS_GROUP");
        });
      }
      const lbBtn = document.getElementById("showLeaderboardBtn");
      if (lbBtn) {
        lbBtn.addEventListener("click", () => {
          playTone(880, 0.3);
          sendAction("SHOW_LEADERBOARD");
        });
      }
    }
  }

  // ============================================================================
  // 6. FASE LEADERBOARD AKHIR (STEP 6: LEADERBOARD)
  // ============================================================================
  function renderLeaderboardView(container, st) {
    const isGM = client.role === "game_master";
    const sortedGroups = [...st.groups].sort(
      (a, b) => b.scoreBreakdown.accumulatedTotal - a.scoreBreakdown.accumulatedTotal
    );

    const medals = ["🥇 Juara 1", "🥈 Juara 2", "🥉 Juara 3"];

    container.innerHTML = `
      <div class="card" style="margin-bottom:18px;text-align:center;padding:28px 20px;">
        <div style="font-size:2.6rem;margin-bottom:6px;">🏆🎉</div>
        <h1 style="font-size:1.75rem;font-weight:900;margin-bottom:4px;">
          Klasemen Akhir &amp; Leaderboard Tinta Estafet
        </h1>
        <p style="color:var(--text-muted);font-size:0.9rem;margin-bottom:20px;">
          Rincian lengkap Poin Penggambar (+100/penebak), Bonus Sisa Tinta (1% = +1 poin), dan Poin Kecepatan Penebak (+30 turun per 3 poin s/d +5 poin).
        </p>

        <div style="overflow-x:auto;">
          <table class="score-table">
            <thead>
              <tr>
                <th>Peringkat</th>
                <th>Grup</th>
                <th>Kata Objek</th>
                <th>Poin Penggambar</th>
                <th>Bonus Sisa Tinta</th>
                <th>Poin Penebak</th>
                <th>Skor Ronde ${st.roundNumber}</th>
                <th>Total Skor</th>
              </tr>
            </thead>
            <tbody>
              ${sortedGroups
                .map((g, idx) => {
                  const sb = g.scoreBreakdown;
                  return `
                    <tr>
                      <td style="font-weight:800;color:${idx === 0 ? "#fde68a" : "#f8fafc"};">
                        ${medals[idx] || `#${idx + 1}`}
                      </td>
                      <td>
                        <span class="group-dot" style="background:${g.color};margin-right:6px;"></span>
                        <strong>${escapeHtml(g.fullName)}</strong>
                      </td>
                      <td style="color:#fde68a;font-weight:700;">${escapeHtml(g.secretWord)}</td>
                      <td>+${sb.drawerPoints} <span style="font-size:0.76rem;color:var(--text-muted);">(${g.correctGuessers.length} penebak)</span></td>
                      <td>+${sb.inkBonus} <span style="font-size:0.76rem;color:var(--text-muted);">(${g.remainingInkPct}% tinta)</span></td>
                      <td>+${sb.guesserPoints}</td>
                      <td style="font-weight:700;">+${sb.roundTotal}</td>
                      <td style="font-size:1.1rem;font-weight:900;color:#10b981;">${sb.accumulatedTotal} Poin</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>

        ${
          isGM
            ? `<div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:24px;">
                <button id="nextRoundBtn" class="btn btn-emerald">
                  🔄 Lanjut Ronde ${st.roundNumber + 1} (Tim Tetap Sama &amp; Akumulasi Skor)
                </button>
                <button id="resetGameBtn" class="btn btn-rose">
                  🗑️ Reset Semua (Ulang Ronde 1 &amp; Acak Tim Baru)
                </button>
              </div>`
            : `<div style="margin-top:20px;color:var(--text-muted);font-size:0.88rem;">
                Menunggu Game Master memulai ronde baru atau mereset permainan...
              </div>`
        }
      </div>

      <!-- Galeri Hasil Karya Seluruh Grup -->
      <div class="grid-2">
        ${st.groups
          .map(
            (g) => `
            <div class="card" style="padding:14px;border-top:4px solid ${g.color};">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <strong>${escapeHtml(g.fullName)} — "${escapeHtml(g.secretWord)}"</strong>
                <span style="color:#10b981;font-weight:700;">+${g.scoreBreakdown.roundTotal} Poin</span>
              </div>
              <div class="canvas-wrapper">
                <canvas id="lbCanvas-${g.id}" class="drawing-canvas readonly" width="800" height="500"></canvas>
              </div>
            </div>
          `
          )
          .join("")}
      </div>
    `;

    st.groups.forEach((g) => {
      const c = document.getElementById(`lbCanvas-${g.id}`);
      renderAllStrokesOnCanvas(c, g.strokes);
    });

    if (isGM) {
      document.getElementById("nextRoundBtn").addEventListener("click", () => {
        sendAction("NEXT_ROUND");
      });
      document.getElementById("resetGameBtn").addEventListener("click", () => {
        sendAction("RESET_GAME");
      });
    }
  }

  // ============================================================================
  // EVENT LISTENER MODAL GLOBAL (PIN GM, WORD BANK, GANTI PERAN / MODE ADMIN)
  // ============================================================================
  document.getElementById("switchRoleBtn").addEventListener("click", () => {
    if (client.role === "player") {
      // 1 Device = 1 Orang: Pemain tidak boleh keluar untuk membuat akun pemain baru.
      // Tombol ini hanya membuka autentikasi PIN jika perangkat ini adalah milik Admin.
      document.getElementById("gmPinModal").classList.remove("hidden");
      document.getElementById("gmPinInput").focus();
      return;
    }
    client.role = null;
    localStorage.removeItem(STORAGE_KEYS.ROLE);
    client.renderedViewKey = "";
    updateTopbar();
    renderMainView();
  });

  document.getElementById("cancelGmModalBtn").addEventListener("click", () => {
    document.getElementById("gmPinModal").classList.add("hidden");
  });

  document.getElementById("gmPinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = document.getElementById("gmPinInput").value.trim();
    const res = await sendAction("AUTH_GM", { pin, playerId: client.playerId });
    if (!res.ok) {
      showToast(res.error || "PIN Salah!", "#f43f5e");
      return;
    }
    client.role = "game_master";
    client.playerId = null;
    client.gmPin = pin;
    localStorage.setItem(STORAGE_KEYS.ROLE, "game_master");
    localStorage.removeItem(STORAGE_KEYS.PLAYER_ID);
    localStorage.setItem(STORAGE_KEYS.GM_PIN, pin);
    document.getElementById("gmPinModal").classList.add("hidden");
    document.getElementById("gmPinInput").value = "";

    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(
        JSON.stringify({
          type: "IDENTIFY",
          role: "game_master",
          deviceId: client.deviceId,
          pin
        })
      );
    }
    playTone(760, 0.16);
    client.renderedViewKey = "";
    renderMainView();
  });

  document.getElementById("closeWordBankBtn").addEventListener("click", () => {
    document.getElementById("wordBankModal").classList.add("hidden");
  });

  document.getElementById("saveWordBankBtn").addEventListener("click", async () => {
    const raw = document.getElementById("wordBankTextarea").value;
    const words = raw
      .split(/[\n,]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    const res = await sendAction("UPDATE_WORD_BANK", { words });
    if (!res.ok) {
      showToast(res.error || "Gagal menyimpan Word Bank", "#f43f5e");
      return;
    }
    showToast(`Berhasil menyimpan ${res.count} kata objek!`, "#10b981");
    document.getElementById("wordBankModal").classList.add("hidden");
  });

  // Event Listener Konfirmasi Kembalikan Semua ke Lobby (Game Master)
  const returnLobbyTopBtnEl = document.getElementById("returnLobbyTopBtn");
  const returnLobbyModalEl = document.getElementById("returnLobbyModal");
  const cancelReturnLobbyBtnEl = document.getElementById("cancelReturnLobbyBtn");
  const confirmReturnLobbyBtnEl = document.getElementById("confirmReturnLobbyBtn");

  if (returnLobbyTopBtnEl && returnLobbyModalEl) {
    returnLobbyTopBtnEl.addEventListener("click", () => {
      returnLobbyModalEl.classList.remove("hidden");
    });
  }
  if (cancelReturnLobbyBtnEl && returnLobbyModalEl) {
    cancelReturnLobbyBtnEl.addEventListener("click", () => {
      returnLobbyModalEl.classList.add("hidden");
    });
  }
  if (confirmReturnLobbyBtnEl && returnLobbyModalEl) {
    confirmReturnLobbyBtnEl.addEventListener("click", async () => {
      returnLobbyModalEl.classList.add("hidden");
      const res = await sendAction("RETURN_TO_LOBBY");
      if (!res.ok) {
        showToast(res.error || "Gagal mengembalikan ke Lobby", "#f43f5e");
        return;
      }
      playTone(440, 0.16);
      showToast("Seluruh peserta telah dikembalikan ke Lobby.", "#38bdf8");
    });
  }

  // Inisialisasi aplikasi
  setInterval(updateDrawingTimersDOM, 250);
  connectWebSocket();
  const initHeaders =
    client.role === "game_master" && client.gmPin ? { "X-GM-Pin": client.gmPin } : {};
  fetch(
    `/api/state?role=${encodeURIComponent(client.role || "player")}&playerId=${encodeURIComponent(
      client.playerId || ""
    )}&deviceId=${encodeURIComponent(client.deviceId || "")}`,
    { headers: initHeaders }
  )
    .then((r) => r.json())
    .then((data) => {
      if (client.role === "game_master" && data && data.gmVerified === false) {
        client.role = null;
        client.gmPin = "";
        localStorage.removeItem(STORAGE_KEYS.ROLE);
        localStorage.removeItem(STORAGE_KEYS.GM_PIN);
      }
      if (data.state) handleStateUpdate(data.state);
    })
    .catch(() => {});
})();
