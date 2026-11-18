const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { DEFAULT_WORDS, BOT_NAMES, generateBotStrokesForTurn } = require("./words");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 40;
const GM_DEFAULT_PIN = process.env.GM_PIN || "3015";

// Konfigurasi Porsi Tinta Per Orang
const INK_CAPACITY_MODES = {
  HEMAT: {
    ink_per_player: 1000,
    total_group_ink: 1000,
    description: "Menantang, butuh efisiensi goresan tinggi"
  },
  STANDAR: {
    ink_per_player: 2000,
    total_group_ink: 2000,
    description: "Porsi seimbang untuk setiap pemain"
  },
  BANYAK: {
    ink_per_player: 4000,
    total_group_ink: 4000,
    description: "Leluasa untuk detail gambar dan warna"
  }
};

const GROUP_COLORS = [
  { id: 1, name: "Grup 1 (Merah)", badge: "#EF4444", light: "#FEE2E2" },
  { id: 2, name: "Grup 2 (Biru)", badge: "#3B82F6", light: "#DBEAFE" },
  { id: 3, name: "Grup 3 (Hijau)", badge: "#10B981", light: "#D1FAE5" },
  { id: 4, name: "Grup 4 (Kuning)", badge: "#F59E0B", light: "#FEF3C7" },
  { id: 5, name: "Grup 5 (Ungu)", badge: "#8B5CF6", light: "#EDE9FE" },
  { id: 6, name: "Grup 6 (Pink)", badge: "#EC4899", light: "#FCE7F3" },
  { id: 7, name: "Grup 7 (Cyan)", badge: "#06B6D4", light: "#CFFAFE" },
  { id: 8, name: "Grup 8 (Oranye)", badge: "#F97316", light: "#FFEDD5" }
];

const DRAWING_TOOLS = {
  visibility_mode: "OPEN_RELAY",
  colors: ["#000000", "#EF4444", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#92400E"],
  brush_sizes: [
    { label: "Tipis", size: 3, ink_multiplier: 1.0 },
    { label: "Sedang", size: 6, ink_multiplier: 1.6 },
    { label: "Tebal", size: 11, ink_multiplier: 2.5 }
  ],
  eraser_allowed: true,
  undo_allowed: false
};

// State Utama Permainan
const gameState = {
  phase: "LOBBY", // LOBBY | DRAWING | READY_TO_GUESS | GUESSING | REVEAL | LEADERBOARD
  roundNumber: 1,
  teamsLocked: false, // Dikunci setelah ronde pertama dimulai agar tim tidak teracak lagi di ronde berikutnya
  settings: {
    maxPlayers: 40, // [20, 30, 40, 50, 60]
    groupCount: 4, // [2, 3, 4, 5, 6, 7, 8]
    inkCapacityMode: "STANDAR", // HEMAT | STANDAR | BANYAK (Porsi Per Orang)
    turnDurationSeconds: 20, // [0, 15, 20, 30]
    passInkBehavior: "PORSI_TETAP", // PORSI_TETAP | INHERITED | WASTED
    fuzzyMatching: true // Deteksi tebakan mendekati untuk memunculkan tulisan "Hampir benar!"
  },
  customWords: [...DEFAULT_WORDS],
  usedWords: new Set(),
  players: [], // { id, name, groupId, isBot, connected, turnOrder }
  groups: [], // Array of group objects
  activeGuessGroupIndex: 0, // Indeks grup (0 .. groupCount-1) yang sedang ditebak pada fase GUESSING / REVEAL
  clueActive: false, // Status apakah Clue huruf pertama + "_ _ _" sedang ditampilkan oleh GM
  clueRevealedCount: 1, // Jumlah huruf awalan yang ditampilkan pada Clue
  guessFeed: [], // [{ id, playerName, groupId, text, isCorrect, isClose, timestamp }]
  accumulatedScores: {} // { [groupId]: number } untuk multi-ronde
};

// WebSocket Clients: Map<ws, { clientId, role, playerId }>
const wsClients = new Map();

// Interval Timer Server (100ms tick untuk akurasi waktu & aksi Bot)
let gameLoopTimer = null;
let wsKeepAliveTimer = null;

// Cache alamat IP Lokal (LAN) selama 30 detik agar tidak membebani CPU saat broadcast ke 40 pemain
let cachedLocalIPs = null;
let cachedLocalIPsAt = 0;
function getLocalIPs() {
  const now = Date.now();
  if (cachedLocalIPs && now - cachedLocalIPsAt < 30000) {
    return cachedLocalIPs;
  }
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  cachedLocalIPs = ips;
  cachedLocalIPsAt = now;
  return ips;
}

// Algoritma Levenshtein Distance untuk Fuzzy Matching
function levenshteinDistance(a, b) {
  const s1 = a.toLowerCase().trim().replace(/\s+/g, " ");
  const s2 = b.toLowerCase().trim().replace(/\s+/g, " ");
  if (s1 === s2) return 0;
  const m = s1.length;
  const n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Inisialisasi struktur grup berdasarkan settings.groupCount & porsi tinta per orang
function syncGroupsStructure() {
  const count = gameState.settings.groupCount;
  const inkPerPlayer = INK_CAPACITY_MODES[gameState.settings.inkCapacityMode].ink_per_player;
  const newGroups = [];

  for (let i = 1; i <= count; i++) {
    const existing = gameState.groups.find((g) => g.id === i);
    const meta = GROUP_COLORS[i - 1] || GROUP_COLORS[0];
    const memberCount = Math.max(1, gameState.players.filter((p) => p.groupId === i).length);
    const calculatedGroupInk = memberCount * inkPerPlayer;

    newGroups.push({
      id: i,
      name: `Grup ${i}`,
      fullName: meta.name,
      color: meta.badge,
      lightColor: meta.light,
      secretWord: existing ? existing.secretWord : "",
      inkPerPlayer,
      initialInk: gameState.phase === "LOBBY" ? calculatedGroupInk : (existing ? existing.initialInk : calculatedGroupInk),
      remainingInk: gameState.phase === "LOBBY" ? calculatedGroupInk : (existing ? existing.remainingInk : calculatedGroupInk),
      carriedOverInk: existing ? existing.carriedOverInk : 0,
      turnInkLimit: existing ? existing.turnInkLimit : inkPerPlayer,
      turnInkRemaining: existing ? existing.turnInkRemaining : inkPerPlayer,
      currentTurnIndex: existing ? existing.currentTurnIndex : 0,
      status: existing ? existing.status : "WAITING", // WAITING | COUNTDOWN | DRAWING | FINISHED
      countdownEndAt: existing ? existing.countdownEndAt : 0,
      turnEndAt: existing ? existing.turnEndAt : 0,
      strokes: existing ? existing.strokes : [],
      correctGuessers: existing ? existing.correctGuessers : [], // [{ playerId, playerName, groupId }]
      scoreBreakdown: existing
        ? existing.scoreBreakdown
        : {
            drawerPoints: 0,
            inkBonus: 0,
            guesserPoints: 0,
            roundTotal: 0,
            accumulatedTotal: gameState.accumulatedScores[i] || 0
          }
    });
  }
  gameState.groups = newGroups;
}

// Re-balance / Acak Ulang pembagian grup (selisih anggota antar grup maksimal 1 orang)
function rebalanceGroups(shuffleAll = true) {
  syncGroupsStructure();
  const groupCount = gameState.settings.groupCount;
  const orderedPlayers = shuffleAll ? shuffleArray(gameState.players) : [...gameState.players];

  // Reset urutan
  const groupBuckets = Array.from({ length: groupCount }, () => []);
  // Acak urutan grup awal supaya bila jumlah pemain tidak habis dibagi, grup yang dapat +1 orang juga acak
  const groupOrder = shuffleArray(Array.from({ length: groupCount }, (_, idx) => idx));

  orderedPlayers.forEach((player, index) => {
    const targetBucketIdx = groupOrder[index % groupCount];
    groupBuckets[targetBucketIdx].push(player);
  });

  groupBuckets.forEach((bucket, idx) => {
    const groupId = idx + 1;
    bucket.forEach((player, turnIdx) => {
      player.groupId = groupId;
      player.turnOrder = turnIdx + 1;
    });
  });
}

// Menambahkan 1 pemain baru ke grup yang jumlah anggotanya paling sedikit saat ini (auto-balanced random)
function assignNewPlayerToBalancedGroup(player) {
  syncGroupsStructure();
  const groupCount = gameState.settings.groupCount;
  const counts = {};
  for (let i = 1; i <= groupCount; i++) counts[i] = 0;

  gameState.players.forEach((p) => {
    if (p.id !== player.id && p.groupId >= 1 && p.groupId <= groupCount) {
      counts[p.groupId]++;
    }
  });

  const minCount = Math.min(...Object.values(counts));
  const candidateGroupIds = Object.keys(counts)
    .map(Number)
    .filter((gid) => counts[gid] === minCount);

  const chosenGroupId = candidateGroupIds[Math.floor(Math.random() * candidateGroupIds.length)];
  player.groupId = chosenGroupId;
  player.turnOrder = counts[chosenGroupId] + 1;
}

function getGroupMembers(groupId) {
  return gameState.players
    .filter((p) => p.groupId === groupId)
    .sort((a, b) => a.turnOrder - b.turnOrder);
}

// Merapikan nomor urut giliran (1..N) di dalam masing-masing grup tanpa memindahkan tim pemain
function normalizeGroupTurnOrders() {
  for (let gid = 1; gid <= gameState.settings.groupCount; gid++) {
    const members = getGroupMembers(gid);
    members.forEach((m, idx) => {
      m.turnOrder = idx + 1;
    });
  }
}

// Ambil kata rahasia unik untuk tiap grup
function pickSecretWords(count) {
  const pool = gameState.customWords.length >= count ? gameState.customWords : DEFAULT_WORDS;
  let available = pool.filter((w) => !gameState.usedWords.has(w));
  if (available.length < count) {
    gameState.usedWords.clear();
    available = [...pool];
  }
  const shuffled = shuffleArray(available);
  const selected = shuffled.slice(0, count);
  selected.forEach((w) => gameState.usedWords.add(w));
  return selected;
}

// Mulai giliran seorang anggota di dalam grup pada fase DRAWING
function startGroupMemberTurn(group, turnIndex, withCountdown = true) {
  const members = getGroupMembers(group.id);
  if (turnIndex >= members.length || group.remainingInk <= 0.5) {
    group.status = "FINISHED";
    group.currentTurnIndex = members.length;
    group.turnInkRemaining = 0;
    checkAllGroupsFinishedDrawing();
    return;
  }

  group.currentTurnIndex = turnIndex;
  const inkPerPlayer =
    group.inkPerPlayer ||
    INK_CAPACITY_MODES[gameState.settings.inkCapacityMode].ink_per_player;
  const baseShare = inkPerPlayer;

  // Hitung kuota tinta untuk giliran pemain ini sesuai porsi per orang (+ warisan jika mode INHERITED)
  const desiredTurnInk = Math.min(
    group.remainingInk,
    baseShare + (group.carriedOverInk || 0)
  );
  group.turnInkLimit = Math.max(0, Math.round(desiredTurnInk));
  group.turnInkRemaining = group.turnInkLimit;
  group.carriedOverInk = 0;

  const now = Date.now();
  const countdownMs = withCountdown ? 3000 : 500;
  group.status = "COUNTDOWN";
  group.countdownEndAt = now + countdownMs;
  group.turnEndAt =
    gameState.settings.turnDurationSeconds > 0
      ? now + countdownMs + gameState.settings.turnDurationSeconds * 1000
      : 0; // 0 = Tanpa Batas Waktu

  // Jika pemain aktif adalah Bot, jadwalkan gambar otomatis
  const activeMember = members[turnIndex];
  if (activeMember && activeMember.isBot) {
    scheduleBotDrawing(group, activeMember, turnIndex, countdownMs);
  }
}

// Simulasi Bot menggambar secara bertahap (real-time stroke streaming)
function scheduleBotDrawing(group, botPlayer, turnIndex, delayMs) {
  const members = getGroupMembers(group.id);
  const botStrokes = generateBotStrokesForTurn(
    group.secretWord,
    turnIndex,
    members.length,
    DRAWING_TOOLS.colors
  );

  let startDelay = delayMs + 700;
  botStrokes.forEach((stroke, sIdx) => {
    const pts = stroke.points;
    for (let i = 1; i < pts.length; i++) {
      const segDelay = startDelay + i * 75;
      setTimeout(() => {
        if (
          gameState.phase !== "DRAWING" ||
          group.status !== "DRAWING" ||
          group.currentTurnIndex !== turnIndex
        ) {
          return;
        }
        applyStrokeSegment(group.id, botPlayer.id, {
          x1: pts[i - 1].x,
          y1: pts[i - 1].y,
          x2: pts[i].x,
          y2: pts[i].y,
          color: stroke.color,
          size: stroke.size,
          inkMultiplier: stroke.inkMultiplier
        });
      }, segDelay);
    }
    startDelay += pts.length * 75 + 350;
  });

  // Bot menekan Pass setelah selesai menggambar polanya
  setTimeout(() => {
    if (
      gameState.phase === "DRAWING" &&
      (group.status === "DRAWING" || group.status === "COUNTDOWN") &&
      group.currentTurnIndex === turnIndex
    ) {
      handlePassTurn(group.id, botPlayer.id, true);
    }
  }, startDelay + 600);
}

// Proses goresan kanvas & pengurangan tinta secara real-time (termasuk fitur Penghapus)
function applyStrokeSegment(groupId, playerId, segment) {
  if (gameState.phase !== "DRAWING") return false;
  const group = gameState.groups.find((g) => g.id === groupId);
  if (!group || group.status !== "DRAWING") return false;

  const members = getGroupMembers(groupId);
  const activePlayer = members[group.currentTurnIndex];
  if (!activePlayer || activePlayer.id !== playerId) return false;

  const isEraser = Boolean(segment.isEraser) || String(segment.color).toUpperCase() === "#FFFFFF";

  if (!isEraser && (group.turnInkRemaining <= 0 || group.remainingInk <= 0)) {
    handlePassTurn(groupId, playerId, false);
    return false;
  }

  const x1 = Math.max(0, Math.min(800, Number(segment.x1) || 0));
  const y1 = Math.max(0, Math.min(500, Number(segment.y1) || 0));
  const x2 = Math.max(0, Math.min(800, Number(segment.x2) || 0));
  const y2 = Math.max(0, Math.min(500, Number(segment.y2) || 0));

  const brushInfo =
    DRAWING_TOOLS.brush_sizes.find((b) => b.size === Number(segment.size)) ||
    DRAWING_TOOLS.brush_sizes[1];

  const dist = Math.hypot(x2 - x1, y2 - y1);
  if (dist < 0.2) return false;

  // Penghapus menggunakan warna putih kanvas (#FFFFFF) dan tidak mengurangi maupun mengembalikan tinta (0x)
  const inkCost = isEraser ? 0 : dist * brushInfo.ink_multiplier;
  group.turnInkRemaining = Math.max(0, group.turnInkRemaining - inkCost);
  group.remainingInk = Math.max(0, group.remainingInk - inkCost);

  const cleanSegment = {
    x1: Math.round(x1 * 10) / 10,
    y1: Math.round(y1 * 10) / 10,
    x2: Math.round(x2 * 10) / 10,
    y2: Math.round(y2 * 10) / 10,
    color: isEraser
      ? "#FFFFFF"
      : DRAWING_TOOLS.colors.includes(segment.color)
      ? segment.color
      : "#000000",
    size: brushInfo.size,
    isEraser,
    playerId
  };

  group.strokes.push(cleanSegment);

  // Stream langsung ke anggota grup tersebut & GM
  broadcastStroke(groupId, cleanSegment, {
    remainingInk: Math.round(group.remainingInk),
    turnInkRemaining: Math.round(group.turnInkRemaining),
    turnInkLimit: Math.round(group.turnInkLimit)
  });

  // Jika tinta habis di tengah goresan kuas warna, otomatis lanjut ke giliran berikutnya
  if (!isEraser && (group.turnInkRemaining <= 0.5 || group.remainingInk <= 0.5)) {
    handlePassTurn(groupId, playerId, false);
  }
  return true;
}

// Menangani tombol Pass atau saat waktu/tinta seorang pemain habis
function handlePassTurn(groupId, playerId, isManualPass = true) {
  const group = gameState.groups.find((g) => g.id === groupId);
  if (!group || group.status === "FINISHED") return;

  const members = getGroupMembers(groupId);
  const activePlayer = members[group.currentTurnIndex];
  if (playerId && (!activePlayer || activePlayer.id !== playerId)) return;

  const leftoverTurnInk = Math.max(0, group.turnInkRemaining);
  const isLastMember = group.currentTurnIndex + 1 >= members.length;

  if (gameState.settings.passInkBehavior === "INHERITED") {
    // Sisa tinta pemain diwariskan ke pemain berikutnya dalam grup
    group.carriedOverInk = isLastMember ? 0 : leftoverTurnInk;
  } else if (gameState.settings.passInkBehavior === "WASTED") {
    // Mode WASTED: Sisa tinta jatah pemain tersebut hangus saat klik Pass / selesai giliran
    group.carriedOverInk = 0;
    group.remainingInk = Math.max(0, group.remainingInk - leftoverTurnInk);
  } else {
    // Mode PORSI_TETAP (Default): Porsi pemain berikutnya tetap sesuai porsi per orang,
    // sedangkan sisa tinta pemain ini otomatis ditabung di remainingInk untuk Bonus Skor Grup
    group.carriedOverInk = 0;
  }

  group.turnInkRemaining = 0;
  startGroupMemberTurn(group, group.currentTurnIndex + 1, true);
  broadcastState();
}

function checkAllGroupsFinishedDrawing() {
  if (gameState.phase !== "DRAWING") return;
  const activeGroups = gameState.groups.filter((g) => getGroupMembers(g.id).length > 0);
  const allDone =
    activeGroups.length > 0 && activeGroups.every((g) => g.status === "FINISHED");

  if (allDone) {
    gameState.phase = "READY_TO_GUESS";
    broadcastState();
  }
}

// Mulai Fase Menggambar (Step 2)
function startDrawingPhase() {
  syncGroupsStructure();
  normalizeGroupTurnOrders();
  const secretWords = pickSecretWords(gameState.settings.groupCount);
  const inkPerPlayer = INK_CAPACITY_MODES[gameState.settings.inkCapacityMode].ink_per_player;

  // Kunci pembagian tim sejak Ronde 1 dimulai agar di ronde berikutnya tim tidak diacak ulang
  gameState.teamsLocked = true;
  gameState.phase = "DRAWING";
  gameState.activeGuessGroupIndex = 0;
  gameState.clueActive = false;
  gameState.clueRevealedCount = 1;
  gameState.guessFeed = [];

  gameState.groups.forEach((group, idx) => {
    const members = getGroupMembers(group.id);
    const totalGroupInk = Math.max(1, members.length) * inkPerPlayer;
    group.secretWord = secretWords[idx] || DEFAULT_WORDS[idx];
    group.inkPerPlayer = inkPerPlayer;
    group.initialInk = totalGroupInk;
    group.remainingInk = totalGroupInk;
    group.carriedOverInk = 0;
    group.strokes = [];
    group.correctGuessers = [];
    group.scoreBreakdown = {
      drawerPoints: 0,
      inkBonus: 0,
      guesserPoints: 0,
      roundTotal: 0,
      accumulatedTotal: gameState.accumulatedScores[group.id] || 0
    };

    if (members.length === 0) {
      group.status = "FINISHED";
      group.currentTurnIndex = 0;
      group.turnInkLimit = 0;
      group.turnInkRemaining = 0;
    } else {
      startGroupMemberTurn(group, 0, true);
    }
  });

  broadcastState();
}

// Mulai Fase Menebak untuk Grup tertentu (Step 4)
function startGuessingForGroup(groupIndex) {
  if (groupIndex < 0 || groupIndex >= gameState.groups.length) return;
  gameState.phase = "GUESSING";
  gameState.activeGuessGroupIndex = groupIndex;
  gameState.clueActive = false;
  gameState.clueRevealedCount = 1;
  gameState.guessFeed = [];
  broadcastState();

  // Jadwalkan Bot dari grup lain untuk ikut menebak
  scheduleBotsGuessing(groupIndex);
}

function scheduleBotsGuessing(groupIndex) {
  const targetGroup = gameState.groups[groupIndex];
  if (!targetGroup) return;

  const otherBots = gameState.players.filter(
    (p) => p.isBot && p.groupId !== targetGroup.id
  );

  const wrongGuessesPool = shuffleArray(
    DEFAULT_WORDS.filter((w) => w.toLowerCase() !== targetGroup.secretWord.toLowerCase())
  );

  otherBots.forEach((bot, idx) => {
    // Tebakan pertama (kadang salah/lucu, kadang langsung benar)
    const firstDelay = 2200 + idx * 1400 + Math.floor(Math.random() * 1500);
    setTimeout(() => {
      if (
        gameState.phase !== "GUESSING" ||
        gameState.activeGuessGroupIndex !== groupIndex
      ) {
        return;
      }
      const willGuessRightFirst = Math.random() < 0.35;
      const guessWord = willGuessRightFirst
        ? targetGroup.secretWord
        : wrongGuessesPool[idx % wrongGuessesPool.length] || "Kucing";
      handlePlayerGuess(bot.id, guessWord);
    }, firstDelay);

    // Tebakan kedua (peluang benar lebih tinggi)
    const secondDelay = firstDelay + 3500 + Math.floor(Math.random() * 2000);
    setTimeout(() => {
      if (
        gameState.phase !== "GUESSING" ||
        gameState.activeGuessGroupIndex !== groupIndex
      ) {
        return;
      }
      const alreadyGuessed = targetGroup.correctGuessers.some(
        (cg) => cg.playerId === bot.id
      );
      if (!alreadyGuessed && Math.random() < 0.55) {
        handlePlayerGuess(bot.id, targetGroup.secretWord);
      }
    }, secondDelay);
  });
}

// Proses tebakan pemain pada fase GUESSING
function handlePlayerGuess(playerId, rawText) {
  if (gameState.phase !== "GUESSING") return { ok: false };
  const player = gameState.players.find((p) => p.id === playerId);
  if (!player) return { ok: false };

  const targetGroup = gameState.groups[gameState.activeGuessGroupIndex];
  if (!targetGroup) return { ok: false };

  // Anggota grup yang menggambar tidak boleh menebak gambarnya sendiri
  if (player.groupId === targetGroup.id) {
    return { ok: false, error: "Anggota grup penggambar tidak bisa ikut menebak." };
  }

  // Jika sudah menebak benar sebelumnya, kunci inputnya
  if (targetGroup.correctGuessers.some((cg) => cg.playerId === player.id)) {
    return { ok: false, error: "Kamu sudah berhasil menebak gambar ini!" };
  }

  const text = String(rawText || "").trim().slice(0, 60);
  if (!text) return { ok: false };

  const secret = targetGroup.secretWord.trim();
  const sLower = secret.toLowerCase();
  const gLower = text.toLowerCase().replace(/\s+/g, " ");
  const dist = levenshteinDistance(gLower, sLower);

  // Jawaban dianggap BENAR hanya jika sama persis (exact match, tidak peduli huruf besar/kecil)
  const isCorrect = dist === 0;
  const isFuzzyCorrect = false;

  // Fuzzy Matching: jika aktif, deteksi apakah jawaban mendekati / hampir benar
  // (typo 1-2 huruf, spasi terpisah seperti "kaca mata", atau peserta mengetik beberapa kata yang memuat kata rahasia)
  const gJoined = gLower.replace(/[\s\-_]+/g, "");
  const sJoined = sLower.replace(/[\s\-_]+/g, "");
  const joinedDist = levenshteinDistance(gJoined, sJoined);

  const guessTokens = gLower.split(/[\s\-_,./]+/).filter(Boolean);
  const isTokenClose =
    !isCorrect &&
    guessTokens.some((token) => {
      if (token === sLower) return true; // Kata rahasia ada di dalam rangkaian beberapa kata yang diketik peserta
      const tDist = levenshteinDistance(token, sLower);
      if (sLower.length >= 3 && tDist === 1) return true;
      if (sLower.length >= 5 && tDist === 2) return true;
      if (
        token.length >= 3 &&
        (sLower.includes(token) || token.includes(sLower)) &&
        token.length >= Math.ceil(sLower.length * 0.6)
      ) {
        return true;
      }
      return false;
    });

  const isWholeClose =
    !isCorrect &&
    ((secret.length >= 3 && dist === 1) ||
      (secret.length >= 5 && dist === 2) ||
      joinedDist === 0 ||
      (sJoined.length >= 3 && joinedDist === 1) ||
      (gLower.length >= 3 &&
        (sLower.includes(gLower) || gLower.includes(sLower)) &&
        gLower.length >= Math.ceil(sLower.length * 0.6)));

  const isClose =
    !isCorrect &&
    Boolean(gameState.settings.fuzzyMatching) &&
    (isWholeClose || isTokenClose);

  if (isCorrect) {
    // Urutan penebak benar (0-indexed) -> Poin mulai dari 30, turun 3 poin tiap urutan berikutnya, minimal 5 poin
    const orderIndex = targetGroup.correctGuessers.length;
    const rank = orderIndex + 1;
    const pointsEarned = Math.max(5, 30 - orderIndex * 3);

    targetGroup.correctGuessers.push({
      playerId: player.id,
      playerName: player.name,
      groupId: player.groupId,
      isFuzzy: isFuzzyCorrect,
      rank,
      points: pointsEarned
    });

    gameState.guessFeed.unshift({
      id: crypto.randomUUID(),
      playerId: player.id,
      playerName: player.name,
      groupId: player.groupId,
      text: `🎉 Berhasil menebak benar! (Tercepat #${rank} • +${pointsEarned} Poin)`,
      isCorrect: true,
      isClose: false,
      rank,
      points: pointsEarned,
      timestamp: Date.now()
    });

    if (gameState.guessFeed.length > 60) {
      gameState.guessFeed.length = 60;
    }

    // Saat pemain menebak, gambar di kanvas tidak berubah -> broadcast state ringan tanpa strokes!
    broadcastState({ omitStrokes: true });
    return {
      ok: true,
      isCorrect: true,
      isFuzzyCorrect,
      isClose: false,
      rank,
      pointsEarned
    };
  } else {
    gameState.guessFeed.unshift({
      id: crypto.randomUUID(),
      playerId: player.id,
      playerName: player.name,
      groupId: player.groupId,
      text,
      isCorrect: false,
      isClose,
      timestamp: Date.now()
    });
  }

  if (gameState.guessFeed.length > 60) {
    gameState.guessFeed.length = 60;
  }

  // Broadcast state ringan tanpa mengirim ulang ribuan titik gambar
  broadcastState({ omitStrokes: true });
  return { ok: true, isCorrect: false, isFuzzyCorrect: false, isClose };
}

// Hitung ulang skor seluruh grup sesuai aturan kecepatan penebak (30 turun per 3 poin s/d min 5 poin)
function recalculateAllScores() {
  // Reset poin ronde
  gameState.groups.forEach((g) => {
    g.scoreBreakdown.drawerPoints = 0;
    g.scoreBreakdown.inkBonus = 0;
    g.scoreBreakdown.guesserPoints = 0;
    g.scoreBreakdown.roundTotal = 0;
  });

  // Hitung poin tiap grup
  gameState.groups.forEach((g) => {
    const correctCount = g.correctGuessers.length;
    // +100 poin per penebak benar dari grup lain
    const drawerPts = correctCount * 100;

    // Bonus Tinta: 1% sisa tinta grup = +1 poin bonus
    // Syarat: Minimal harus ada 1 penebak benar dari grup lain
    const remainingPct = Math.round((Math.max(0, g.remainingInk) / g.initialInk) * 100);
    const inkBonus = correctCount >= 1 ? remainingPct : 0;

    g.scoreBreakdown.drawerPoints = drawerPts;
    g.scoreBreakdown.inkBonus = inkBonus;

    // Poin penebak berdasarkan kecepatan urutan menebak (30, 27, 24, ..., minimal 5 poin)
    g.correctGuessers.forEach((cg, idx) => {
      const guesserGroup = gameState.groups.find((grp) => grp.id === cg.groupId);
      if (guesserGroup) {
        const pts = typeof cg.points === "number" ? cg.points : Math.max(5, 30 - idx * 3);
        guesserGroup.scoreBreakdown.guesserPoints += pts;
      }
    });
  });

  gameState.groups.forEach((g) => {
    g.scoreBreakdown.roundTotal =
      g.scoreBreakdown.drawerPoints +
      g.scoreBreakdown.inkBonus +
      g.scoreBreakdown.guesserPoints;
    g.scoreBreakdown.accumulatedTotal =
      (gameState.accumulatedScores[g.id] || 0) + g.scoreBreakdown.roundTotal;
  });
}

// Helper membaca cookie dari HTTP header untuk identifikasi 1 Device = 1 Orang
function parseCookies(req) {
  const list = {};
  const cookieHeader = req && req.headers ? req.headers.cookie : "";
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const key = parts.shift().trim();
    if (key) {
      list[key] = decodeURIComponent(parts.join("=").trim());
    }
  });
  return list;
}

// Game Loop 200ms untuk transisi Countdown -> Drawing dan Habis Waktu Giliran
function startServerGameLoop() {
  if (gameLoopTimer) clearInterval(gameLoopTimer);
  gameLoopTimer = setInterval(() => {
    if (gameState.phase !== "DRAWING") return;
    const now = Date.now();
    let changed = false;

    gameState.groups.forEach((group) => {
      if (group.status === "COUNTDOWN" && now >= group.countdownEndAt) {
        group.status = "DRAWING";
        changed = true;
      } else if (
        group.status === "DRAWING" &&
        gameState.settings.turnDurationSeconds > 0 &&
        group.turnEndAt > 0 &&
        now >= group.turnEndAt
      ) {
        // Waktu giliran habis -> otomatis lanjut ke anggota berikutnya
        const members = getGroupMembers(group.id);
        const activePlayer = members[group.currentTurnIndex];
        handlePassTurn(group.id, activePlayer ? activePlayer.id : null, false);
        changed = true;
      }
    });

    if (changed) {
      broadcastState();
    }
  }, 200);

  // WebSocket Keep-Alive Ping tiap 25 detik agar koneksi di Railway / Cloud Proxy tidak putus saat idle
  if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer);
  wsKeepAliveTimer = setInterval(() => {
    const pingFrame = Buffer.from([0x89, 0x00]);
    for (const [ws] of wsClients.entries()) {
      if (ws && !ws.destroyed && ws.writable) {
        try {
          ws.write(pingFrame);
        } catch (e) {}
      }
    }
  }, 25000);
}

// Membuat payload state yang aman sesuai Role & Grup penerima (agar kata rahasia grup lain tidak bocor)
function buildClientState(role, playerId, deviceId = null, options = {}) {
  const omitStrokes = Boolean(options && options.omitStrokes);
  let viewer = gameState.players.find((p) => p.id === playerId) || null;
  if (!viewer && deviceId) {
    viewer = gameState.players.find((p) => !p.isBot && p.deviceId === deviceId) || null;
  }
  const viewerGroupId = viewer ? viewer.groupId : null;
  const now = Date.now();
  const localIPs = getLocalIPs();

  const sanitizedGroups = gameState.groups.map((g, idx) => {
    const members = getGroupMembers(g.id);
    const activeMember = members[g.currentTurnIndex] || null;

    // Kapan kata rahasia grup boleh terlihat oleh klien ini?
    // 1. Jika pemain adalah anggota grup tersebut saat fase DRAWING
    // 2. Jika fase REVEAL dan grup ini sedang/sudah di-reveal
    // 3. Jika fase LEADERBOARD
    // 4. Jika role === "game_master"
    const isRevealedGroup =
      gameState.phase === "LEADERBOARD" ||
      (gameState.phase === "REVEAL" && idx <= gameState.activeGuessGroupIndex) ||
      (gameState.phase === "GUESSING" && idx < gameState.activeGuessGroupIndex);

    const canSeeSecretWord =
      role === "game_master" ||
      isRevealedGroup ||
      (gameState.phase === "DRAWING" && viewerGroupId === g.id);

    // Kapan kanvas (strokes) grup ini dikirim ke klien?
    // - Saat DRAWING: hanya anggota grup itu sendiri (Open Relay) & Game Master
    // - Saat GUESSING & REVEAL: HANYA 1 grup yang sedang ditebak saja (bergantian Kelompok 1, lalu Kelompok 2, dst.)
    // - Saat LEADERBOARD: semua grup untuk galeri akhir
    const isCurrentlyGuessedGroup =
      (gameState.phase === "GUESSING" || gameState.phase === "REVEAL") &&
      idx === gameState.activeGuessGroupIndex;

    const canSeeCanvas =
      (gameState.phase === "DRAWING" && (role === "game_master" || viewerGroupId === g.id)) ||
      isCurrentlyGuessedGroup ||
      gameState.phase === "LEADERBOARD";

    const remainingInkPct = Math.round(
      (Math.max(0, g.remainingInk) / Math.max(1, g.initialInk)) * 100
    );

    // Clue huruf awalan + "_ _ _" sesuai jumlah huruf kata rahasia jika diaktifkan oleh GM saat GUESSING
    const rawSecret = String(g.secretWord || "").trim();
    const secretChars = Array.from(rawSecret);
    const maxClueLetters = Math.max(1, secretChars.length - 1);
    const revealedCount = Math.max(
      1,
      Math.min(maxClueLetters, Number(gameState.clueRevealedCount) || 1)
    );
    const showClueNow =
      gameState.phase === "GUESSING" &&
      idx === gameState.activeGuessGroupIndex &&
      Boolean(gameState.clueActive) &&
      secretChars.length > 0;
    const clueText = showClueNow
      ? secretChars
          .map((ch, cIdx) => (cIdx < revealedCount ? ch.toUpperCase() : /\s/.test(ch) ? "  " : "_"))
          .join(" ")
      : null;

    return {
      id: g.id,
      name: g.name,
      fullName: g.fullName,
      color: g.color,
      lightColor: g.lightColor,
      secretWord: canSeeSecretWord ? g.secretWord : "???",
      clueText,
      clueLength: showClueNow ? secretChars.length : null,
      clueRevealedCount: showClueNow ? revealedCount : 0,
      clueMaxLetters: secretChars.length > 0 ? maxClueLetters : 1,
      inkPerPlayer:
        g.inkPerPlayer ||
        INK_CAPACITY_MODES[gameState.settings.inkCapacityMode].ink_per_player,
      initialInk: g.initialInk,
      remainingInk: Math.round(g.remainingInk),
      remainingInkPct,
      turnInkLimit: Math.round(g.turnInkLimit),
      turnInkRemaining: Math.round(g.turnInkRemaining),
      currentTurnIndex: g.currentTurnIndex,
      activePlayerId: activeMember ? activeMember.id : null,
      activePlayerName: activeMember ? activeMember.name : null,
      status: g.status,
      countdownRemainingSec:
        g.status === "COUNTDOWN"
          ? Math.max(0, Math.ceil((g.countdownEndAt - now) / 1000))
          : 0,
      turnRemainingSec:
        g.status === "DRAWING"
          ? gameState.settings.turnDurationSeconds === 0
            ? null
            : Math.max(0, Math.ceil((g.turnEndAt - now) / 1000))
          : 0,
      members,
      strokes: omitStrokes ? undefined : canSeeCanvas ? g.strokes : [],
      correctGuessers: g.correctGuessers,
      scoreBreakdown: g.scoreBreakdown
    };
  });

  // Filter guessFeed: tebakan yang "hampir benar / mendekati" (isClose) HANYA boleh terlihat oleh peserta itu sendiri
  const visibleGuessFeed = gameState.guessFeed.filter((item) => {
    if (item.isClose) {
      return Boolean(viewer && item.playerId && item.playerId === viewer.id);
    }
    return true;
  });

  const activeGroupObj = gameState.groups[gameState.activeGuessGroupIndex];
  const activeSecretChars = Array.from(
    String(activeGroupObj ? activeGroupObj.secretWord : "").trim()
  );
  const activeMaxClueLetters = Math.max(1, activeSecretChars.length - 1);
  const activeClueRevealedCount = Math.max(
    1,
    Math.min(activeMaxClueLetters, Number(gameState.clueRevealedCount) || 1)
  );

  return {
    phase: gameState.phase,
    roundNumber: gameState.roundNumber,
    teamsLocked: Boolean(gameState.teamsLocked),
    strokesOmitted: omitStrokes,
    maxPlayers: gameState.settings.maxPlayers || MAX_PLAYERS,
    settings: gameState.settings,
    inkCapacityModes: INK_CAPACITY_MODES,
    drawingTools: DRAWING_TOOLS,
    players: gameState.players,
    groups: sanitizedGroups,
    boundPlayer: viewer && !viewer.isBot ? viewer : null,
    activeGuessGroupIndex: gameState.activeGuessGroupIndex,
    clueActive: Boolean(gameState.clueActive),
    clueRevealedCount: activeClueRevealedCount,
    guessFeed: visibleGuessFeed,
    customWordsCount: gameState.customWords.length,
    customWords: role === "game_master" ? gameState.customWords : undefined,
    localIPs,
    port: PORT,
    serverTime: now
  };
}

// Implementasi RFC 6455 WebSocket Frame Encoder & Decoder (Zero Dependency)
function encodeWsFrame(dataStr) {
  const payload = Buffer.from(dataStr, "utf8");
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + Text Frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendWsMessage(ws, obj) {
  if (!ws || ws.destroyed || !ws.writable) return;
  try {
    const frame = encodeWsFrame(JSON.stringify(obj));
    ws.write(frame);
  } catch (err) {
    // Abaikan jika socket sudah ditutup
  }
}

function broadcastState(options = {}) {
  for (const [ws, meta] of wsClients.entries()) {
    sendWsMessage(ws, {
      type: "STATE_UPDATE",
      state: buildClientState(meta.role, meta.playerId, meta.deviceId, options)
    });
  }
}

function broadcastStroke(groupId, segment, inkInfo) {
  for (const [ws, meta] of wsClients.entries()) {
    const viewer = gameState.players.find((p) => p.id === meta.playerId);
    if (meta.role === "game_master" || (viewer && viewer.groupId === groupId)) {
      sendWsMessage(ws, {
        type: "STROKE_STREAM",
        groupId,
        segment,
        inkInfo
      });
    }
  }
}

// Handler untuk seluruh Action dari Player maupun Game Master
function handleAction(action, payload, clientMeta) {
  switch (action) {
    case "JOIN_PLAYER": {
      const name = String(payload.name || "").trim().slice(0, 24);
      const deviceId = String(
        payload.deviceId || (clientMeta && clientMeta.deviceId) || ""
      ).trim();

      // Cek apakah perangkat (deviceId) atau playerId ini sudah terdaftar sebagai pemain (1 Device = 1 Orang)
      let player = null;
      if (deviceId) {
        player = gameState.players.find((p) => !p.isBot && p.deviceId === deviceId) || null;
      }
      if (!player && payload.playerId) {
        player = gameState.players.find((p) => !p.isBot && p.id === payload.playerId) || null;
      }

      if (!player) {
        const currentMaxPlayers = gameState.settings.maxPlayers || MAX_PLAYERS;
        if (!name) return { ok: false, error: "Nama panggilan wajib diisi." };
        if (gameState.players.length >= currentMaxPlayers) {
          return { ok: false, error: `Lobby penuh (Maksimal ${currentMaxPlayers} pemain).` };
        }
        player = {
          id: crypto.randomUUID(),
          name,
          deviceId: deviceId || crypto.randomUUID(),
          groupId: 1,
          turnOrder: 1,
          isBot: false,
          connected: true
        };
        gameState.players.push(player);
        assignNewPlayerToBalancedGroup(player);
        syncGroupsStructure();
      } else {
        // Perangkat sudah terdaftar sebagai pemain -> gunakan pemain yang sama (tidak boleh buat pemain ke-2)
        if (deviceId && !player.deviceId) {
          player.deviceId = deviceId;
        }
        player.connected = true;
      }

      if (clientMeta) {
        clientMeta.role = "player";
        clientMeta.playerId = player.id;
        if (player.deviceId) clientMeta.deviceId = player.deviceId;
      }
      broadcastState();
      return { ok: true, player };
    }

    case "AUTH_GM": {
      const pin = String(payload.pin || "").trim();
      if (pin !== GM_DEFAULT_PIN) {
        return { ok: false, error: "PIN Game Master salah!" };
      }
      // Jika perangkat Admin sebelumnya sempat masuk sebagai pemain di Lobby, hapus agar tidak menjadi pemain kosong
      const gmDeviceId = String(
        payload.deviceId || (clientMeta && clientMeta.deviceId) || ""
      ).trim();
      if (gameState.phase === "LOBBY" && (gmDeviceId || payload.playerId)) {
        const beforeLen = gameState.players.length;
        gameState.players = gameState.players.filter(
          (p) =>
            p.isBot ||
            (p.id !== payload.playerId && (!gmDeviceId || p.deviceId !== gmDeviceId))
        );
        if (gameState.players.length !== beforeLen) {
          normalizeGroupTurnOrders();
        }
      }
      if (clientMeta) {
        clientMeta.role = "game_master";
        clientMeta.playerId = null;
      }
      broadcastState();
      return { ok: true, role: "game_master" };
    }

    case "UPDATE_SETTINGS": {
      if (gameState.phase !== "LOBBY") {
        return { ok: false, error: "Pengaturan hanya dapat diubah saat di Lobby." };
      }
      if ([20, 30, 40, 50, 60].includes(Number(payload.maxPlayers))) {
        gameState.settings.maxPlayers = Number(payload.maxPlayers);
      }
      const prevGroupCount = gameState.settings.groupCount;
      if ([2, 3, 4, 5, 6, 7, 8].includes(Number(payload.groupCount))) {
        if (gameState.teamsLocked && Number(payload.groupCount) !== prevGroupCount) {
          return {
            ok: false,
            error: "Jumlah grup tidak bisa diubah karena tim sudah dikunci sejak Ronde 1. Gunakan tombol 'Reset Semua' jika ingin merombak tim."
          };
        }
        gameState.settings.groupCount = Number(payload.groupCount);
      }
      if (INK_CAPACITY_MODES[payload.inkCapacityMode]) {
        gameState.settings.inkCapacityMode = payload.inkCapacityMode;
      }
      if ([0, 15, 20, 30].includes(Number(payload.turnDurationSeconds))) {
        gameState.settings.turnDurationSeconds = Number(payload.turnDurationSeconds);
      }
      if (["PORSI_TETAP", "INHERITED", "WASTED"].includes(payload.passInkBehavior)) {
        gameState.settings.passInkBehavior = payload.passInkBehavior;
      }
      if (typeof payload.fuzzyMatching === "boolean") {
        gameState.settings.fuzzyMatching = payload.fuzzyMatching;
      }

      if (!gameState.teamsLocked && prevGroupCount !== gameState.settings.groupCount) {
        rebalanceGroups(false);
        syncGroupsStructure();
      } else {
        syncGroupsStructure();
        normalizeGroupTurnOrders();
      }
      broadcastState();
      return { ok: true };
    }

    case "RESHUFFLE_GROUPS": {
      if (gameState.phase !== "LOBBY") {
        return { ok: false, error: "Acak ulang hanya bisa dilakukan di Lobby." };
      }
      if (gameState.teamsLocked) {
        return {
          ok: false,
          error: "Tim sudah dikunci sejak Ronde 1! Gunakan pemindah pemain manual atau tombol 'Reset Semua'."
        };
      }
      rebalanceGroups(true);
      broadcastState();
      return { ok: true };
    }

    case "MOVE_PLAYER_GROUP": {
      if (gameState.phase !== "LOBBY") {
        return { ok: false, error: "Pemain hanya dapat dipindahkan saat berada di Lobby." };
      }
      const targetPlayer = gameState.players.find((p) => p.id === payload.playerId);
      const targetGroupId = Number(payload.targetGroupId);
      if (!targetPlayer) {
        return { ok: false, error: "Pemain tidak ditemukan." };
      }
      if (
        !Number.isInteger(targetGroupId) ||
        targetGroupId < 1 ||
        targetGroupId > gameState.settings.groupCount
      ) {
        return { ok: false, error: "Grup tujuan tidak valid." };
      }

      if (targetPlayer.groupId !== targetGroupId) {
        const destMembers = getGroupMembers(targetGroupId);
        targetPlayer.groupId = targetGroupId;
        targetPlayer.turnOrder = destMembers.length + 1;
        normalizeGroupTurnOrders();
        broadcastState();
      }
      return {
        ok: true,
        playerName: targetPlayer.name,
        targetGroupId
      };
    }

    case "MOVE_PLAYER_ORDER": {
      if (gameState.phase !== "LOBBY") {
        return { ok: false, error: "Urutan giliran hanya dapat diubah saat di Lobby." };
      }
      const targetPlayer = gameState.players.find((p) => p.id === payload.playerId);
      if (!targetPlayer) {
        return { ok: false, error: "Pemain tidak ditemukan." };
      }
      const members = getGroupMembers(targetPlayer.groupId);
      const idx = members.findIndex((p) => p.id === targetPlayer.id);
      if (idx === -1) return { ok: false };

      const dir = payload.direction === "UP" ? -1 : 1;
      const swapIdx = idx + dir;
      if (swapIdx >= 0 && swapIdx < members.length) {
        const other = members[swapIdx];
        const tmpOrder = targetPlayer.turnOrder;
        targetPlayer.turnOrder = other.turnOrder;
        other.turnOrder = tmpOrder;
        normalizeGroupTurnOrders();
        broadcastState();
      }
      return { ok: true };
    }

    case "ADD_BOT": {
      if (gameState.phase !== "LOBBY") {
        return { ok: false, error: "Bot hanya bisa ditambahkan saat di Lobby." };
      }
      const currentMaxPlayers = gameState.settings.maxPlayers || MAX_PLAYERS;
      const count = Math.max(1, Math.min(12, Number(payload.count) || 1));
      let added = 0;

      for (let i = 0; i < count; i++) {
        if (gameState.players.length >= currentMaxPlayers) break;
        const existingNames = new Set(gameState.players.map((p) => p.name));
        const availableBotName =
          BOT_NAMES.find((bn) => !existingNames.has(bn)) ||
          `Bot #${gameState.players.length + 1}`;

        const bot = {
          id: `bot-${crypto.randomUUID()}`,
          name: availableBotName,
          groupId: 1,
          turnOrder: 1,
          isBot: true,
          connected: true
        };
        gameState.players.push(bot);
        assignNewPlayerToBalancedGroup(bot);
        added++;
      }

      syncGroupsStructure();
      broadcastState();
      return { ok: true, added };
    }

    case "REMOVE_BOTS": {
      if (gameState.phase !== "LOBBY") return { ok: false };
      gameState.players = gameState.players.filter((p) => !p.isBot);
      if (gameState.teamsLocked) {
        normalizeGroupTurnOrders();
      } else {
        rebalanceGroups(false);
      }
      broadcastState();
      return { ok: true };
    }

    case "KICK_PLAYER": {
      const targetId = payload.playerId;
      const targetPlayer = gameState.players.find((p) => p.id === targetId);
      if (!targetPlayer) {
        return { ok: false, error: "Pemain tidak ditemukan." };
      }

      const targetGroupId = targetPlayer.groupId;
      const group = gameState.groups.find((g) => g.id === targetGroupId);
      const oldMembers = getGroupMembers(targetGroupId);
      const kickedIndex = oldMembers.findIndex((p) => p.id === targetId);

      gameState.players = gameState.players.filter((p) => p.id !== targetId);

      // Beritahu browser pemain yang di-kick melalui WebSocket agar tidak auto-rejoin
      for (const [ws, meta] of wsClients.entries()) {
        if (meta.playerId === targetId) {
          meta.playerId = null;
          meta.role = null;
          sendWsMessage(ws, {
            type: "PLAYER_KICKED",
            playerId: targetId,
            message: "Kamu telah dikeluarkan dari ruangan oleh Game Master."
          });
        }
      }

      if (gameState.phase === "LOBBY") {
        // Jangan mengacak grup pemain lain yang sudah di grupnya, cukup rapikan nomor urut
        normalizeGroupTurnOrders();
      } else if (group) {
        // Rapikan kembali turnOrder anggota grup yang tersisa
        const remainingMembers = getGroupMembers(targetGroupId);
        remainingMembers.forEach((m, idx) => {
          m.turnOrder = idx + 1;
        });

        if (gameState.phase === "DRAWING" && group.status !== "FINISHED") {
          if (kickedIndex !== -1 && kickedIndex < group.currentTurnIndex) {
            group.currentTurnIndex = Math.max(0, group.currentTurnIndex - 1);
          } else if (kickedIndex === group.currentTurnIndex) {
            startGroupMemberTurn(group, group.currentTurnIndex, true);
          }
        }
      }

      broadcastState();
      return { ok: true, kickedName: targetPlayer.name };
    }

    case "UPDATE_WORD_BANK": {
      const rawWords = Array.isArray(payload.words) ? payload.words : [];
      const cleaned = rawWords
        .map((w) => String(w || "").trim())
        .filter((w) => w.length >= 2);
      const multiWord = cleaned.find((w) => /\s/.test(w));
      if (multiWord) {
        return {
          ok: false,
          error: `Kata "${multiWord}" terdiri dari lebih dari 1 kata. Gunakan cukup 1 kata saja untuk setiap objek.`
        };
      }
      if (cleaned.length < 6) {
        return { ok: false, error: "Word Bank minimal harus berisi 6 kata objek (masing-masing 1 kata)." };
      }
      gameState.customWords = cleaned;
      gameState.usedWords.clear();
      broadcastState();
      return { ok: true, count: cleaned.length };
    }

    case "START_DRAWING_PHASE": {
      if (gameState.players.length < 2) {
        return {
          ok: false,
          error: "Minimal harus ada 2 pemain di Lobby (Gunakan tombol '+ Tambah Bot' untuk simulasi)."
        };
      }
      startDrawingPhase();
      return { ok: true };
    }

    case "DRAW_STROKE": {
      const ok = applyStrokeSegment(
        Number(payload.groupId),
        payload.playerId,
        payload.segment || {}
      );
      return { ok };
    }

    case "PASS_TURN": {
      handlePassTurn(Number(payload.groupId), payload.playerId, true);
      return { ok: true };
    }

    case "GM_SKIP_MEMBER_TURN": {
      if (gameState.phase !== "DRAWING") {
        return { ok: false, error: "Skip giliran hanya dapat dilakukan saat fase menggambar." };
      }
      const group = gameState.groups.find((g) => g.id === Number(payload.groupId));
      if (!group || group.status === "FINISHED") {
        return { ok: false, error: "Grup tidak ditemukan atau sudah selesai menggambar." };
      }

      const members = getGroupMembers(group.id);
      const skippedMember = members[group.currentTurnIndex];
      const leftoverTurnInk = Math.max(0, group.turnInkRemaining);
      const isLastMember = group.currentTurnIndex + 1 >= members.length;

      // Sisa tinta peserta yang di-skip tidak dihanguskan agar grup tidak dirugikan
      if (gameState.settings.passInkBehavior === "INHERITED") {
        group.carriedOverInk = isLastMember ? 0 : leftoverTurnInk;
      } else {
        group.carriedOverInk = 0;
      }

      group.turnInkRemaining = 0;
      startGroupMemberTurn(group, group.currentTurnIndex + 1, true);
      broadcastState();
      return {
        ok: true,
        skippedName: skippedMember ? skippedMember.name : "Pemain",
        groupName: group.name
      };
    }

    case "FORCE_FINISH_DRAWING": {
      gameState.groups.forEach((g) => {
        g.status = "FINISHED";
      });
      gameState.phase = "READY_TO_GUESS";
      broadcastState();
      return { ok: true };
    }

    case "START_GUESSING_PHASE": {
      startGuessingForGroup(0);
      return { ok: true };
    }

    case "SUBMIT_GUESS": {
      return handlePlayerGuess(payload.playerId, payload.text);
    }

    case "TOGGLE_CLUE": {
      if (gameState.phase !== "GUESSING") {
        return { ok: false, error: "Clue hanya dapat ditampilkan saat fase menebak." };
      }
      const nextActive =
        typeof payload.active === "boolean" ? payload.active : !gameState.clueActive;
      gameState.clueActive = nextActive;
      gameState.clueRevealedCount = 1;
      broadcastState({ omitStrokes: true });
      return {
        ok: true,
        clueActive: gameState.clueActive,
        clueRevealedCount: gameState.clueRevealedCount
      };
    }

    case "ADD_CLUE_LETTER": {
      if (gameState.phase !== "GUESSING") {
        return { ok: false, error: "Clue hanya dapat ditambah saat fase menebak." };
      }
      const targetGroup = gameState.groups[gameState.activeGuessGroupIndex];
      const secretChars = Array.from(
        String(targetGroup ? targetGroup.secretWord : "").trim()
      );
      const maxClueLetters = Math.max(1, secretChars.length - 1);

      if (!gameState.clueActive) {
        gameState.clueActive = true;
        gameState.clueRevealedCount = 1;
      } else if (gameState.clueRevealedCount < maxClueLetters) {
        gameState.clueRevealedCount += 1;
      }
      broadcastState({ omitStrokes: true });
      return {
        ok: true,
        clueActive: gameState.clueActive,
        clueRevealedCount: gameState.clueRevealedCount
      };
    }

    case "REVEAL_CURRENT_GROUP": {
      if (gameState.phase !== "GUESSING") return { ok: false };
      gameState.clueActive = false;
      gameState.clueRevealedCount = 1;
      recalculateAllScores();
      gameState.phase = "REVEAL";
      broadcastState();
      return { ok: true };
    }

    case "NEXT_GUESS_GROUP": {
      const nextIdx = gameState.activeGuessGroupIndex + 1;
      if (nextIdx < gameState.groups.length) {
        startGuessingForGroup(nextIdx);
      } else {
        recalculateAllScores();
        gameState.phase = "LEADERBOARD";
        broadcastState();
      }
      return { ok: true };
    }

    case "SHOW_LEADERBOARD": {
      recalculateAllScores();
      gameState.phase = "LEADERBOARD";
      broadcastState();
      return { ok: true };
    }

    case "NEXT_ROUND": {
      // Simpan akumulasi skor lalu kembali ke Lobby untuk ronde berikutnya (Tim dikunci, tidak diacak ulang!)
      recalculateAllScores();
      gameState.groups.forEach((g) => {
        gameState.accumulatedScores[g.id] = g.scoreBreakdown.accumulatedTotal;
      });
      gameState.roundNumber += 1;
      gameState.teamsLocked = true;
      gameState.phase = "LOBBY";
      syncGroupsStructure();
      normalizeGroupTurnOrders();
      broadcastState();
      return { ok: true };
    }

    case "RETURN_TO_LOBBY": {
      // Hentikan ronde yang sedang berjalan dan kembalikan seluruh peserta ke Lobby tanpa meng-kick peserta
      gameState.phase = "LOBBY";
      gameState.guessFeed = [];
      gameState.activeGuessGroupIndex = 0;
      gameState.clueActive = false;
      gameState.clueRevealedCount = 1;
      if (gameState.roundNumber <= 1) {
        gameState.teamsLocked = false;
      }
      gameState.groups = [];
      syncGroupsStructure();
      normalizeGroupTurnOrders();
      broadcastState();
      return { ok: true };
    }

    case "RESET_GAME": {
      // Reset Semua: kembalikan ke Ronde 1, nolkan semua skor akumulasi, buka kunci tim, dan acak ulang tim
      gameState.roundNumber = 1;
      gameState.teamsLocked = false;
      gameState.accumulatedScores = {};
      gameState.usedWords.clear();
      gameState.phase = "LOBBY";
      gameState.guessFeed = [];
      gameState.clueActive = false;
      gameState.clueRevealedCount = 1;
      gameState.groups = [];
      syncGroupsStructure();
      rebalanceGroups(true);
      broadcastState();
      return { ok: true };
    }

    default:
      return { ok: false, error: "Action tidak dikenali." };
  }
}

// Inisialisasi awal grup
syncGroupsStructure();
startServerGameLoop();

// HTTP Server untuk Static Files & Fallback API
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const cookies = parseCookies(req);
  let cookieDeviceId = cookies["tinta_device_id"] || "";
  if (!cookieDeviceId) {
    cookieDeviceId = `dev-${crypto.randomUUID()}`;
    res.setHeader(
      "Set-Cookie",
      `tinta_device_id=${encodeURIComponent(cookieDeviceId)}; Path=/; Max-Age=86400; SameSite=Lax`
    );
  }

  // Endpoint API State (GET)
  if (pathname === "/api/state" && req.method === "GET") {
    const role = parsedUrl.searchParams.get("role") || "player";
    const playerId = parsedUrl.searchParams.get("playerId") || null;
    const deviceId = parsedUrl.searchParams.get("deviceId") || cookieDeviceId;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        deviceId,
        state: buildClientState(role, playerId, deviceId)
      })
    );
    return;
  }

  // Endpoint API Action (POST)
  if (pathname === "/api/action" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const deviceId =
          (data.payload && data.payload.deviceId) || data.deviceId || cookieDeviceId;
        const payloadWithDevice = { ...(data.payload || {}), deviceId };
        const result = handleAction(data.action, payloadWithDevice, { deviceId });
        const finalPlayerId =
          (result.player && result.player.id) || data.playerId || null;
        const omitStrokes =
          data.action === "SUBMIT_GUESS" ||
          data.action === "TOGGLE_CLUE" ||
          data.action === "ADD_CLUE_LETTER";
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ...result,
            deviceId,
            state: buildClientState(data.role || "player", finalPlayerId, deviceId, {
              omitStrokes
            })
          })
        );
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON payload" }));
      }
    });
    return;
  }

  // Layani file statis dari folder public/
  const publicDir = path.join(__dirname, "public");
  let safePath = pathname === "/" ? "/index.html" : pathname;
  safePath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      // Fallback SPA ke index.html
      fs.readFile(path.join(publicDir, "index.html"), (err2, indexContent) => {
        if (err2) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("404 Not Found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(indexContent);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
});

// Penanganan Upgrade WebSocket (RFC 6455)
server.on("upgrade", (req, socket) => {
  if (req.headers["upgrade"] !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request");
    return;
  }

  const acceptKey = req.headers["sec-websocket-key"];
  const hash = crypto
    .createHash("sha1")
    .update(acceptKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "binary")
    .digest("base64");

  const responseHeaders = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${hash}`,
    "\r\n"
  ];
  socket.write(responseHeaders.join("\r\n"));

  const cookies = parseCookies(req);
  const clientMeta = {
    clientId: crypto.randomUUID(),
    role: "player",
    playerId: null,
    deviceId: cookies["tinta_device_id"] || null
  };
  wsClients.set(socket, clientMeta);

  // Kirim state awal
  sendWsMessage(socket, {
    type: "STATE_UPDATE",
    state: buildClientState(clientMeta.role, clientMeta.playerId, clientMeta.deviceId)
  });

  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = Boolean(secondByte & 0x80);
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) return;

      const maskKey = isMasked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;

      const payloadBuf = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      buffer = buffer.subarray(offset + payloadLen);

      if (opcode === 0x8) {
        // Close frame
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        // Ping -> Pong
        const pong = Buffer.from([0x8a, 0x00]);
        socket.write(pong);
        continue;
      }
      if (opcode === 0x1) {
        // Text frame
        if (isMasked && maskKey) {
          for (let i = 0; i < payloadBuf.length; i++) {
            payloadBuf[i] ^= maskKey[i % 4];
          }
        }
        try {
          const msg = JSON.parse(payloadBuf.toString("utf8"));
          if (msg.type === "IDENTIFY") {
            if (msg.deviceId) {
              clientMeta.deviceId = msg.deviceId;
            }
            if (msg.role === "game_master" && msg.pin === GM_DEFAULT_PIN) {
              clientMeta.role = "game_master";
            }
            if (msg.playerId) {
              clientMeta.playerId = msg.playerId;
              const p = gameState.players.find((pl) => pl.id === msg.playerId);
              if (p) p.connected = true;
            } else if (clientMeta.deviceId && clientMeta.role !== "game_master") {
              const bound = gameState.players.find(
                (pl) => !pl.isBot && pl.deviceId === clientMeta.deviceId
              );
              if (bound) {
                clientMeta.playerId = bound.id;
                bound.connected = true;
              }
            }
            sendWsMessage(socket, {
              type: "STATE_UPDATE",
              state: buildClientState(
                clientMeta.role,
                clientMeta.playerId,
                clientMeta.deviceId
              )
            });
          } else if (msg.type === "ACTION") {
            const res = handleAction(msg.action, msg.payload || {}, clientMeta);
            sendWsMessage(socket, {
              type: "ACTION_RESULT",
              requestId: msg.requestId,
              action: msg.action,
              result: res
            });
          }
        } catch (e) {
          // Abaikan JSON tidak valid
        }
      }
    }
  });

  socket.on("close", () => {
    const meta = wsClients.get(socket);
    if (meta && meta.playerId) {
      const p = gameState.players.find((pl) => pl.id === meta.playerId);
      if (p) p.connected = false;
    }
    wsClients.delete(socket);
  });

  socket.on("error", () => {
    wsClients.delete(socket);
  });
});

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    const ips = getLocalIPs();
    console.log("==================================================");
    console.log("🎨 TINTA ESTAFET - MULTIPLAYER SERVER AKTIF!");
    console.log(`👉 Lokal (Laptop ini): http://localhost:${PORT}`);
    if (ips.length > 0) {
      console.log(`👉 Jaringan/LAN:       http://${ips[0]}:${PORT}`);
    }
    console.log(`🔑 PIN Default Game Master: ${GM_DEFAULT_PIN}`);
    console.log("==================================================");
  });
}

module.exports = {
  handleAction,
  buildClientState,
  gameState,
  server
};

