/*
 * Minimal Standalone QR Code SVG Generator (Byte Mode, ECC Level L, Versions 1-10)
 * Zero external dependencies - Works 100% offline & online
 */
(function (global) {
  // GF(256) math for Reed-Solomon
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const root = EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], root);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGeneratorPoly(ecLen);
    const msg = new Uint8Array(data.length + ecLen);
    msg.set(data, 0);
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(data.length);
  }

  // Version table for ECC Level L (versions 1..10): [totalDataCodewords, ecCodewordsPerBlock, numBlocks, alignmentCenters]
  const VERSION_TABLE = [
    null,
    { dataBytes: 19, ecBytes: 7, blocks: 1, align: [] },
    { dataBytes: 34, ecBytes: 10, blocks: 1, align: [6, 18] },
    { dataBytes: 55, ecBytes: 15, blocks: 1, align: [6, 22] },
    { dataBytes: 80, ecBytes: 20, blocks: 1, align: [6, 26] },
    { dataBytes: 108, ecBytes: 26, blocks: 1, align: [6, 30] },
    { dataBytes: 136, ecBytes: 18, blocks: 2, align: [6, 34] },
    { dataBytes: 156, ecBytes: 20, blocks: 2, align: [6, 22, 38] }
  ];

  function encodeQRMatrix(text) {
    const utf8 = new TextEncoder().encode(text);
    let ver = 1;
    while (ver < VERSION_TABLE.length) {
      const maxLen = VERSION_TABLE[ver].dataBytes - 2;
      if (utf8.length <= maxLen) break;
      ver++;
    }
    if (ver >= VERSION_TABLE.length) return null;

    const info = VERSION_TABLE[ver];
    const bits = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    }

    // Byte mode indicator (0100)
    pushBits(0b0100, 4);
    pushBits(utf8.length, 8);
    for (let i = 0; i < utf8.length; i++) pushBits(utf8[i], 8);

    const maxBits = info.dataBytes * 8;
    pushBits(0, Math.min(4, maxBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);

    const dataCodewords = new Uint8Array(info.dataBytes);
    for (let i = 0; i < bits.length / 8; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
      dataCodewords[i] = b;
    }
    const padBytes = [0xec, 0x11];
    for (let i = bits.length / 8, p = 0; i < info.dataBytes; i++, p ^= 1) {
      dataCodewords[i] = padBytes[p];
    }

    // Split into blocks if needed
    const blockSize = info.dataBytes / info.blocks;
    const dataBlocks = [];
    const ecBlocks = [];
    for (let b = 0; b < info.blocks; b++) {
      const slice = dataCodewords.slice(b * blockSize, (b + 1) * blockSize);
      dataBlocks.push(slice);
      ecBlocks.push(rsEncode(slice, info.ecBytes));
    }

    const finalCodewords = [];
    for (let i = 0; i < blockSize; i++) {
      for (let b = 0; b < info.blocks; b++) finalCodewords.push(dataBlocks[b][i]);
    }
    for (let i = 0; i < info.ecBytes; i++) {
      for (let b = 0; b < info.blocks; b++) finalCodewords.push(ecBlocks[b][i]);
    }

    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

    function setFunctionModule(r, c, dark) {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        modules[r][c] = dark;
        isFunction[r][c] = true;
      }
    }

    function drawFinder(r, c) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFunctionModule(rr, cc, inOuter && (inBorder || inInner));
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFunctionModule(6, i, i % 2 === 0);
      setFunctionModule(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    const align = info.align;
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === align.length - 1) ||
          (i === align.length - 1 && j === 0)
        ) {
          continue;
        }
        const cr = align[i];
        const cc = align[j];
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunctionModule(cr + dr, cc + dc, dark);
          }
        }
      }
    }

    // Reserve format info areas
    for (let i = 0; i <= 8; i++) {
      if (!isFunction[8][i]) setFunctionModule(8, i, false);
      if (!isFunction[i][8]) setFunctionModule(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      setFunctionModule(8, size - 1 - i, false);
      setFunctionModule(size - 1 - i, 8, false);
    }
    setFunctionModule(size - 8, 8, true); // Dark module

    // Place data bits in zigzag
    let bitIdx = 0;
    const totalBits = finalCodewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (!isFunction[r][c] && bitIdx < totalBits) {
            const byte = finalCodewords[bitIdx >> 3];
            const dark = ((byte >> (7 - (bitIdx & 7))) & 1) !== 0;
            modules[r][c] = dark;
            bitIdx++;
          }
        }
      }
    }

    // Apply Mask 0: (r + c) % 2 === 0
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunction[r][c] && (r + c) % 2 === 0) {
          modules[r][c] = !modules[r][c];
        }
      }
    }

    // Format bits for ECC Level L (01) + Mask 0 (000) -> 0x77c4
    const formatBits = 0x77c4;
    for (let i = 0; i <= 5; i++) modules[8][i] = ((formatBits >> i) & 1) !== 0;
    modules[8][7] = ((formatBits >> 6) & 1) !== 0;
    modules[8][8] = ((formatBits >> 7) & 1) !== 0;
    modules[7][8] = ((formatBits >> 8) & 1) !== 0;
    for (let i = 9; i < 15; i++) modules[14 - i][8] = ((formatBits >> i) & 1) !== 0;

    for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = ((formatBits >> i) & 1) !== 0;
    for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = ((formatBits >> i) & 1) !== 0;

    return modules;
  }

  function renderQRCodeSVG(text, pixelSize = 200) {
    const matrix = encodeQRMatrix(text);
    if (!matrix) {
      return `<div style="padding:16px;text-align:center;font-size:12px;">URL terlalu panjang untuk QR</div>`;
    }
    const n = matrix.length;
    const quiet = 3;
    const total = n + quiet * 2;
    let paths = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" style="border-radius:12px;background:#fff;display:block;margin:0 auto;">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <path d="${paths}" fill="#0f172a"/>
    </svg>`;
  }

  global.renderQRCodeSVG = renderQRCodeSVG;
})(window);
