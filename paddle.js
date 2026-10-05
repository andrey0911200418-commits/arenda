/* Нейросетевое распознавание текста PaddleOCR прямо в браузере (ONNX Runtime Web).
   Детектор строк: PP-OCRv3 mobile (DB). Чтение: PP-OCRv5 mobile (eslav — русский + латиница).
   Фото никуда не отправляются: модели скачиваются с этого же сайта и работают в телефоне. */
(function (root) {
  "use strict";
  var ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
  var MODELS = "models/";
  var DET_LIMIT = 1280;          // макс. сторона для поиска строк (кратна 32)
  var REC_H = 48;                // высота строки для модели чтения
  var MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  var sDet = null, sRec = {}, dicts = {};

  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement("script"); s.src = src; s.onload = ok;
      s.onerror = function () { bad(new Error("Нет интернета — нейросеть не загрузилась (нужна только при первом запуске).")); };
      document.head.appendChild(s);
    });
  }
  async function ensureOrt() {
    if (!root.ort) await loadScript(ORT_BASE + "ort.wasm.min.js");
    root.ort.env.wasm.wasmPaths = ORT_BASE;
    root.ort.env.wasm.numThreads = 1; // GitHub Pages не даёт многопоточность — так стабильнее на телефонах
  }
  async function fetchBuf(url, onp) {
    var r = await fetch(url);
    if (!r.ok) throw new Error("Не удалось загрузить " + url + " (" + r.status + ")");
    var total = +r.headers.get("content-length") || 0;
    if (!r.body || !total || !onp) return new Uint8Array(await r.arrayBuffer());
    var reader = r.body.getReader(), chunks = [], got = 0;
    for (;;) { var x = await reader.read(); if (x.done) break; chunks.push(x.value); got += x.value.length; onp(Math.min(1, got / total)); }
    var out = new Uint8Array(got), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  }
  async function session(name, onp) {
    var buf = await fetchBuf(MODELS + name, onp);
    return root.ort.InferenceSession.create(buf, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  }
  async function loadDict(name) {
    var a = (await (await fetch(MODELS + name)).text()).split(/\r?\n/);
    if (a.length && a[a.length - 1] === "") a.pop();
    return a;
  }
  async function init(step) {
    step = step || function () {};
    await ensureOrt();
    if (!sDet) sDet = await session("det.onnx", function (p) { step("Загружаю нейросеть (только в первый раз): поиск строк…", p); });
    if (!sRec.ru) {
      sRec.ru = await session("rec-ru.onnx", function (p) { step("Загружаю нейросеть (только в первый раз): чтение текста…", p); });
      dicts.ru = await loadDict("dict-ru.txt");
    }
  }

  /* ---------- поиск строк (DB) ---------- */
  function detPrep(canvas) {
    var w = canvas.width, h = canvas.height, r = Math.min(1, DET_LIMIT / Math.max(w, h));
    var nw = Math.max(32, Math.round(w * r / 32) * 32), nh = Math.max(32, Math.round(h * r / 32) * 32);
    var c = document.createElement("canvas"); c.width = nw; c.height = nh;
    var x = c.getContext("2d"); x.drawImage(canvas, 0, 0, nw, nh);
    var d = x.getImageData(0, 0, nw, nh).data, n = nw * nh, t = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) { // каналы BGR, как при обучении PaddleOCR
      t[i] = (d[i * 4 + 2] / 255 - MEAN[0]) / STD[0];
      t[n + i] = (d[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      t[2 * n + i] = (d[i * 4] / 255 - MEAN[2]) / STD[2];
    }
    return { tensor: new root.ort.Tensor("float32", t, [1, 3, nh, nw]), nw: nw, nh: nh, sx: w / nw, sy: h / nh };
  }
  function dbBoxes(prob, W, H) {
    var THR = 0.3, BOX_THR = 0.6, UNCLIP = 1.6;
    var lab = new Uint8Array(W * H), stack = new Int32Array(W * H), boxes = [];
    for (var p = 0; p < W * H; p++) {
      if (prob[p] <= THR || lab[p]) continue;
      var sp = 0; stack[sp++] = p; lab[p] = 1;
      var minx = W, miny = H, maxx = 0, maxy = 0, sum = 0, cnt = 0;
      while (sp) {
        var q = stack[--sp], qx = q % W, qy = (q / W) | 0, a;
        sum += prob[q]; cnt++;
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx; if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        if (qx > 0) { a = q - 1; if (!lab[a] && prob[a] > THR) { lab[a] = 1; stack[sp++] = a; } }
        if (qx < W - 1) { a = q + 1; if (!lab[a] && prob[a] > THR) { lab[a] = 1; stack[sp++] = a; } }
        if (qy > 0) { a = q - W; if (!lab[a] && prob[a] > THR) { lab[a] = 1; stack[sp++] = a; } }
        if (qy < H - 1) { a = q + W; if (!lab[a] && prob[a] > THR) { lab[a] = 1; stack[sp++] = a; } }
      }
      var bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (Math.min(bw, bh) < 3 || sum / cnt < BOX_THR) continue;
      var dd = (bw * bh) * UNCLIP / (2 * (bw + bh)); // расширение рамки как в DB (unclip)
      boxes.push({ x0: minx - dd, y0: miny - dd, x1: maxx + 1 + dd, y1: maxy + 1 + dd });
    }
    return boxes;
  }

  /* ---------- чтение строки (CTC) ---------- */
  async function recBox(canvas, b, which) {
    var sess = sRec[which], dict = dicts[which];
    var x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
    var x1 = Math.min(canvas.width, Math.ceil(b.x1)), y1 = Math.min(canvas.height, Math.ceil(b.y1));
    var w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return null;
    var Wt = Math.max(16, Math.min(3200, Math.ceil(REC_H * w / h)));
    var c = document.createElement("canvas"); c.width = Wt; c.height = REC_H;
    var x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(canvas, x0, y0, w, h, 0, 0, Wt, REC_H);
    var d = x.getImageData(0, 0, Wt, REC_H).data, n = Wt * REC_H, t = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) { t[i] = d[i * 4 + 2] / 127.5 - 1; t[n + i] = d[i * 4 + 1] / 127.5 - 1; t[2 * n + i] = d[i * 4] / 127.5 - 1; }
    var feeds = {}; feeds[sess.inputNames[0]] = new root.ort.Tensor("float32", t, [1, 3, REC_H, Wt]);
    var o = (await sess.run(feeds))[sess.outputNames[0]], T = o.dims[1], C = o.dims[2], pr = o.data;
    var s = "", last = -1, conf = 0, nc = 0;
    for (var ti = 0; ti < T; ti++) {
      var best = -1, bi = 0, base = ti * C;
      for (var ci = 0; ci < C; ci++) { var v = pr[base + ci]; if (v > best) { best = v; bi = ci; } }
      if (bi !== 0 && bi !== last) { s += bi - 1 < dict.length ? dict[bi - 1] : " "; conf += best; nc++; }
      last = bi;
    }
    return { text: s.trim(), conf: nc ? conf / nc : 0 };
  }

  /* ---------- сборка строк текста ---------- */
  function toLines(items) {
    items.sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    var lines = [];
    items.forEach(function (it) {
      var cy = (it.y0 + it.y1) / 2, h = it.y1 - it.y0, L = null;
      for (var i = 0; i < lines.length; i++) if (Math.abs(lines[i].cy - cy) < Math.min(lines[i].h, h) * 0.5) { L = lines[i]; break; }
      if (L) { L.items.push(it); L.cy = (L.cy * L.n + cy) / (L.n + 1); L.n++; L.h = Math.max(L.h, h); }
      else lines.push({ cy: cy, h: h, n: 1, items: [it] });
    });
    lines.sort(function (a, b) { return a.cy - b.cy; });
    return lines.map(function (l) { return l.items.sort(function (a, b) { return a.x0 - b.x0; }).map(function (i) { return i.text; }).join(" "); }).join("\n");
  }

  function rotateCanvas(src, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return src;
    var c = document.createElement("canvas");
    c.width = deg % 180 ? src.height : src.width; c.height = deg % 180 ? src.width : src.height;
    var x = c.getContext("2d"); x.translate(c.width / 2, c.height / 2); x.rotate(deg * Math.PI / 180); x.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }
  async function detect(canvas) {
    var prep = detPrep(canvas), feeds = {};
    feeds[sDet.inputNames[0]] = prep.tensor;
    var prob = (await sDet.run(feeds))[sDet.outputNames[0]].data;
    return dbBoxes(prob, prep.nw, prep.nh).map(function (b) {
      return { x0: b.x0 * prep.sx, y0: b.y0 * prep.sy, x1: b.x1 * prep.sx, y1: b.y1 * prep.sy };
    });
  }
  // Оценка «читаемости» при данном повороте: читаем до 10 самых крупных строк, сумма (уверенность × длина)
  async function orientScore(canvas, known) {
    var boxes = (known || await detect(canvas)).filter(function (b) { return (b.x1 - b.x0) > (b.y1 - b.y0) * 1.3; })
      .sort(function (a, b) { return (b.x1 - b.x0) - (a.x1 - a.x0); }).slice(0, 10), score = 0;
    for (var i = 0; i < boxes.length; i++) {
      var r = await recBox(canvas, boxes[i], "ru");
      if (r && r.text) score += Math.max(0, r.conf - 0.35) * r.text.replace(/\s/g, "").length;
    }
    return score;
  }

  // canvas → { text, items, canvas (уже правильно повёрнутый), rotation }
  async function recognize(canvas, step) {
    step = step || function () {};
    step("Определяю, как повёрнут документ…", null);
    var boxes0 = await detect(canvas), hor = 0, ver = 0;
    boxes0.forEach(function (b) { var w = b.x1 - b.x0, h = b.y1 - b.y0; if (w > h * 1.3) hor++; else if (h > w * 1.3) ver++; });
    var cands = ver > hor ? [90, 270] : [0, 180], best = null;
    for (var ci = 0; ci < cands.length; ci++) {
      var rc = rotateCanvas(canvas, cands[ci]), sc = await orientScore(rc, cands[ci] === 0 ? boxes0 : null);
      if (!best || sc > best.score) best = { deg: cands[ci], canvas: rc, score: sc };
      if (cands[ci] === 0 && sc > 60) break; // текст и так читается уверенно — переворот не проверяем
    }
    var work = best.canvas;
    var boxes = (best.deg === 0 ? boxes0 : await detect(work)).slice(0, 400);
    var items = [];
    for (var i = 0; i < boxes.length; i++) {
      step("Читаю текст… " + (i + 1) + " из " + boxes.length, (i + 1) / boxes.length);
      var r = await recBox(work, boxes[i], "ru");
      if (r && r.text && r.conf >= 0.45) items.push({ x0: boxes[i].x0, y0: boxes[i].y0, x1: boxes[i].x1, y1: boxes[i].y1, text: r.text, conf: r.conf });
    }
    return { text: toLines(items), items: items, canvas: work, rotation: best.deg };
  }

  root.Paddle = { init: init, recognize: recognize, rotateCanvas: rotateCanvas };
})(typeof window !== "undefined" ? window : globalThis);
