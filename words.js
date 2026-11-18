// Word Bank Bawaan Bahasa Indonesia & Generator Gambar Bot untuk Tinta Estafet

const DEFAULT_WORDS = [
  // Hewan (1 Kata)
  "Kucing", "Gajah", "Jerapah", "Gurita", "Buaya", "Pinguin", "Kelinci",
  "Penyu", "Kepiting", "Bunglon", "Hiu", "Komodo", "Ayam", "Sapi",
  "Katak", "Singa", "Harimau", "Zebra", "Panda", "Unta",
  // Makanan & Minuman (1 Kata)
  "Bakso", "Martabak", "Donat", "Semangka", "Pisang", "Durian", "Burger",
  "Pizza", "Kelapa", "Kerupuk", "Permen", "Roti", "Jagung", "Sate",
  "Nanas", "Mangga", "Stroberi", "Keju", "Tumpeng", "Mie",
  // Benda & Kendaraan (1 Kata)
  "Sepeda", "Payung", "Kacamata", "Gitar", "Helikopter", "Kamera", "Televisi",
  "Setrika", "Kompor", "Roket", "Perahu", "Kereta", "Truk", "Becak",
  "Gembok", "Lampu", "Jam", "Kipas", "Sapu", "Balon", "Pesawat",
  "Mobil", "Kunci", "Topi", "Sepatu",
  // Tempat & Alam (1 Kata)
  "Gunung", "Pulau", "Pohon", "Pelangi", "Mercusuar", "Pantai", "Kemah",
  "Istana", "Jembatan", "Masjid", "Sawah", "Rumah", "Matahari", "Kaktus",
  // Karakter & Profesi (1 Kata)
  "Robot", "Astronot", "Ninja", "Koki", "Dokter", "Badut", "Raja", "Polisi"
];

const BOT_NAMES = [
  "Bot Budi", "Bot Siti", "Bot Agus", "Bot Rina", "Bot Joko",
  "Bot Dewi", "Bot Eko", "Bot Maya", "Bot Rizky", "Bot Putri",
  "Bot Hendra", "Bot Lestari", "Bot Fajar", "Bot Nisa", "Bot Dimas",
  "Bot Tari", "Bot Wahyu", "Bot Sari", "Bot Andi", "Bot Mega",
  "Bot Bayu", "Bot Citra", "Bot Gilang", "Bot Wulan", "Bot Reza",
  "Bot Nadya", "Bot Arif", "Bot Bella", "Bot Yoga", "Bot Intan",
  "Bot Kevin", "Bot Dina", "Bot Bagas", "Bot Salsa", "Bot Daffa",
  "Bot Tiara", "Bot Farhan", "Bot Ayu", "Bot Galih", "Bot Nabila"
];

// Generator goresan (strokes) untuk Bot pada fase menggambar
// Menghasilkan beberapa segmen garis yang bertahap sesuai urutan pemain di grup
function generateBotStrokesForTurn(word, turnIndex, totalTurns, colors) {
  const strokes = [];
  const cx = 400; // Kanvas standar 800x500
  const cy = 250;
  const wLower = (word || "").toLowerCase();

  // Pilih warna sesuai jenis objek atau giliran
  const black = "#000000";
  const red = "#EF4444";
  const blue = "#3B82F6";
  const green = "#10B981";
  const amber = "#F59E0B";
  const brown = "#92400E";

  // Helper membuat lingkaran / elips menjadi kumpulan titik
  function makeCirclePoints(x, y, rx, ry, startAngle = 0, endAngle = Math.PI * 2, steps = 20) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = startAngle + ((endAngle - startAngle) * i) / steps;
      pts.push({
        x: Math.round(x + Math.cos(a) * rx),
        y: Math.round(y + Math.sin(a) * ry)
      });
    }
    return pts;
  }

  function makeLinePoints(x1, y1, x2, y2, steps = 10) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({
        x: Math.round(x1 + (x2 - x1) * t),
        y: Math.round(y1 + (y2 - y1) * t)
      });
    }
    return pts;
  }

  // Kumpulan komponen gambar estafet (Giliran 0: kerangka utama, Giliran 1: bagian tengah/atribut, Giliran 2+: detail & aksen)
  const layers = [];

  if (wLower.includes("gunung") || wLower.includes("pantai") || wLower.includes("pulau") || wLower.includes("pelangi")) {
    layers.push([
      { color: brown, size: 6, inkMultiplier: 1.6, points: [...makeLinePoints(120, 380, 340, 140, 14), ...makeLinePoints(340, 140, 520, 380, 14)] },
      { color: green, size: 6, inkMultiplier: 1.6, points: makeLinePoints(80, 380, 720, 380, 16) }
    ]);
    layers.push([
      { color: amber, size: 6, inkMultiplier: 1.6, points: makeCirclePoints(600, 120, 42, 42, 0, Math.PI * 2, 16) },
      { color: red, size: 6, inkMultiplier: 1.6, points: makeCirclePoints(340, 140, 35, 18, Math.PI, Math.PI * 2, 12) }
    ]);
    layers.push([
      { color: blue, size: 3, inkMultiplier: 1.0, points: makeCirclePoints(400, 420, 220, 20, 0, Math.PI, 16) },
      { color: amber, size: 3, inkMultiplier: 1.0, points: makeLinePoints(530, 120, 500, 120, 5) }
    ]);
  } else if (wLower.includes("bakso") || wLower.includes("donat") || wLower.includes("burger") || wLower.includes("pizza") || wLower.includes("semangka")) {
    layers.push([
      { color: brown, size: 6, inkMultiplier: 1.6, points: [...makeLinePoints(320, 250, 400, 420, 12), ...makeLinePoints(400, 420, 480, 250, 12), ...makeLinePoints(480, 250, 320, 250, 10)] }
    ]);
    layers.push([
      { color: "#EC4899", size: 6, inkMultiplier: 1.6, points: makeCirclePoints(400, 210, 85, 70, Math.PI, Math.PI * 2.1, 18) },
      { color: amber, size: 3, inkMultiplier: 1.0, points: makeCirclePoints(400, 145, 55, 45, Math.PI, Math.PI * 2.1, 14) }
    ]);
    layers.push([
      { color: red, size: 6, inkMultiplier: 1.6, points: makeCirclePoints(400, 95, 18, 18, 0, Math.PI * 2, 12) },
      { color: green, size: 3, inkMultiplier: 1.0, points: makeLinePoints(400, 80, 425, 55, 6) }
    ]);
  } else if (wLower.includes("sepeda") || wLower.includes("mobil") || wLower.includes("helikopter") || wLower.includes("kereta") || wLower.includes("roket") || wLower.includes("perahu")) {
    layers.push([
      { color: black, size: 6, inkMultiplier: 1.6, points: makeCirclePoints(270, 330, 55, 55, 0, Math.PI * 2, 18) },
      { color: black, size: 6, inkMultiplier: 1.6, points: makeCirclePoints(530, 330, 55, 55, 0, Math.PI * 2, 18) }
    ]);
    layers.push([
      { color: red, size: 6, inkMultiplier: 1.6, points: [...makeLinePoints(270, 330, 370, 230, 10), ...makeLinePoints(370, 230, 500, 230, 10), ...makeLinePoints(500, 230, 530, 330, 10)] },
      { color: blue, size: 3, inkMultiplier: 1.0, points: makeLinePoints(270, 330, 420, 330, 10) }
    ]);
    layers.push([
      { color: black, size: 6, inkMultiplier: 1.6, points: [...makeLinePoints(480, 180, 505, 230, 8), ...makeLinePoints(460, 180, 515, 180, 6)] },
      { color: amber, size: 3, inkMultiplier: 1.0, points: makeLinePoints(350, 205, 395, 205, 6) }
    ]);
  } else {
    // Bentuk karakter / hewan / objek umum yang lucu
    layers.push([
      { color: black, size: 6, inkMultiplier: 1.6, points: makeCirclePoints(cx, cy, 95, 85, 0, Math.PI * 2, 20) }
    ]);
    layers.push([
      { color: black, size: 3, inkMultiplier: 1.0, points: makeCirclePoints(cx - 35, cy - 20, 12, 12, 0, Math.PI * 2, 10) },
      { color: black, size: 3, inkMultiplier: 1.0, points: makeCirclePoints(cx + 35, cy - 20, 12, 12, 0, Math.PI * 2, 10) },
      { color: red, size: 3, inkMultiplier: 1.0, points: makeCirclePoints(cx, cy + 20, 35, 22, 0, Math.PI, 12) }
    ]);
    layers.push([
      { color: amber, size: 6, inkMultiplier: 1.6, points: [...makeLinePoints(cx - 70, cy - 65, cx - 95, cy - 125, 8), ...makeLinePoints(cx - 95, cy - 125, cx - 30, cy - 82, 8)] },
      { color: amber, size: 6, inkMultiplier: 1.6, points: [...makeLinePoints(cx + 70, cy - 65, cx + 95, cy - 125, 8), ...makeLinePoints(cx + 95, cy - 125, cx + 30, cy - 82, 8)] }
    ]);
  }

  const chosenLayer = layers[turnIndex % layers.length];
  // Tambahkan sedikit variasi organik pada titik-titik agar tampak seperti gambar tangan
  return chosenLayer.map((s) => ({
    color: s.color || colors[0],
    size: s.size || 6,
    inkMultiplier: s.inkMultiplier || 1.6,
    points: s.points.map((p) => ({
      x: Math.max(30, Math.min(770, p.x + Math.round((Math.random() - 0.5) * 6))),
      y: Math.max(30, Math.min(470, p.y + Math.round((Math.random() - 0.5) * 6)))
    }))
  }));
}

module.exports = {
  DEFAULT_WORDS,
  BOT_NAMES,
  generateBotStrokesForTurn
};
