/* Распознавание документов: паспорт РФ (MRZ + печатный текст), прописка, ВУ.
   Парсеры — чистые функции (тестируются в Node). Движок — Tesseract.js в браузере. */
(function (root) {
  "use strict";
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /* ---------- MRZ внутреннего паспорта РФ ---------- */
  // Транслитерация ФИО в MRZ паспорта РФ (обратное отображение)
  var MRZ_RU = { A: "А", B: "Б", V: "В", G: "Г", D: "Д", E: "Е", "2": "Ё", J: "Ж", Z: "З", I: "И", Q: "Й", K: "К", L: "Л", M: "М", N: "Н", O: "О", P: "П", R: "Р", S: "С", T: "Т", U: "У", F: "Ф", H: "Х", C: "Ц", "3": "Ч", "4": "Ш", W: "Щ", X: "Ъ", Y: "Ы", "9": "Ь", "6": "Э", "7": "Ю", "8": "Я" };
  var RU_MRZ = {}; for (var k in MRZ_RU) RU_MRZ[MRZ_RU[k]] = k;
  function mrzVal(ch) { if (ch === "<") return 0; if (ch >= "0" && ch <= "9") return +ch; if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55; return 0; }
  function checkDigit(s) { var w = [7, 3, 1], sum = 0; for (var i = 0; i < s.length; i++) sum += mrzVal(s[i]) * w[i % 3]; return String(sum % 10); }
  var NUMFIX = { O: "0", Q: "0", D: "0", U: "0", I: "1", L: "1", T: "1", Z: "2", S: "5", G: "6", B: "8" };
  function fixNum(s) { return String(s).split("").map(function (c) { return NUMFIX[c] || c; }).join(""); }
  function decodeName(s) { return String(s).split("").map(function (c) { return MRZ_RU[c] || ""; }).join(""); }
  // кириллические «двойники» латиницы → латиница (нейросеть знает оба алфавита)
  var CYR2LAT = { "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "К": "K", "М": "M", "О": "O", "Р": "P", "Т": "T", "Х": "X", "У": "Y", "І": "I" };
  function cleanLine(s) {
    return String(s).toUpperCase().replace(/[АВСЕНКМОРТХУІ]/g, function (c) { return CYR2LAT[c]; })
      .replace(/«/g, "<<").replace(/\s+/g, "").replace(/[^A-Z0-9<]/g, "<");
  }
  // В словах с русскими буквами латинские двойники — ошибка распознавания: «OТЧЕСТVO» → «ОТЧЕСТВО»
  // похожие по виду (A→А, P→Р, H→Н…) + транслитерация для остальных (N→Н, V→В, I→И, R→Р…)
  var LAT2CYR = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У",
    V: "В", I: "И", N: "Н", R: "Р", S: "С", L: "Л", D: "Д", G: "Г", Z: "З", F: "Ф", U: "У",
    a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у" };
  function fixMixedScript(text) {
    return String(text || "").split("\n").map(function (line) {
      if (/</.test(line) || /^[A-Z0-9<\s]{20,}$/.test(line)) return line; // машиночитаемая зона — не трогаем
      return line.replace(/[A-Za-zА-Яа-яЁё0-9-]+/g, function (w) {
        if (!/[А-Яа-яЁё]/.test(w) || !/[A-Za-z]/.test(w)) return w;
        return w.replace(/[A-Za-z]/g, function (c) { return LAT2CYR[c] || c; });
      });
    }).join("\n");
  }
  function yymmdd(s) {
    if (!/^\d{6}$/.test(s)) return "";
    var yy = +s.slice(0, 2), mm = +s.slice(2, 4), dd = +s.slice(4, 6);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
    var cur = new Date().getFullYear() % 100;
    return pad(dd) + "." + pad(mm) + "." + (yy > cur ? 1900 + yy : 2000 + yy);
  }

  /* ---------- восстановление «склеенных» цифр ----------
     Нейросеть-«читалка» (CTC) иногда сливает одинаковые символы подряд: «780000» → «78000».
     Перебираем, где мог быть повтор, и оставляем варианты, у которых сходится контрольная цифра. */
  function expandDigits(str, len) {
    if (str.length === len) return [str];
    if (str.length > len) return [str.slice(str.length - len)];
    if (len - str.length > 2) return [];
    var out = {}, cur = [str];
    while (cur.length && cur[0].length < len) {
      var nx = {};
      cur.forEach(function (c) { for (var i = 0; i < c.length; i++) nx[c.slice(0, i + 1) + c.slice(i)] = 1; });
      cur = Object.keys(nx);
    }
    cur.forEach(function (c) { out[c] = 1; });
    return Object.keys(out);
  }
  function validYMD(s) { var mm = +s.slice(2, 4), dd = +s.slice(4, 6); return /^\d{6}$/.test(s) && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31; }
  function parseMRZ(text) {
    var lines = String(text || "").split(/\n/).map(cleanLine).filter(function (l) { return l.length >= 25; });
    var l1 = null, l2 = null, i, l;
    for (i = 0; i < lines.length; i++) if (/^P[N<A-Z]?RU[S5]/.test(lines[i])) { l1 = lines[i]; break; }
    for (i = 0; i < lines.length; i++) { l = lines[i]; if (l !== l1 && /RU[S5][0-9A-Z]{6}[0-9A-Z<][MF<]/.test(l) && l.search(/RU[S5]/) >= 9) { l2 = l; break; } }
    var res = { found: false, fields: {}, ok: {} };
    if (l2) {
      var idx = l2.search(/RU[S5]/);
      // До «RUS»: 9 цифр (3 цифры серии + номер) + контрольная. После: дата рождения 6 + контр., пол,
      // заполнитель, доп. данные 13 цифр (посл. цифра серии + дата выдачи 6 + код подразделения 6), контр., итоговая контр.
      var pre = fixNum(l2.slice(0, idx)).replace(/[^0-9]/g, "");
      var after = l2.slice(idx + 3), sexPos = after.search(/[MF]/);
      if (sexPos < 0 || sexPos > 9) sexPos = 7;
      var dobRaw = fixNum(after.slice(0, sexPos)).replace(/[^0-9]/g, "");
      var sex = after.charAt(sexPos);
      var tm = /^<*([0-9A-Z]+)<+([0-9A-Z]*)/.exec(after.slice(sexPos + 1)) || ["", "", ""];
      var optRaw = fixNum(tm[1]).replace(/[^0-9]/g, ""), endRaw = fixNum(tm[2]).replace(/[^0-9]/g, "");
      var c3 = endRaw.charAt(0), comp = endRaw.charAt(1);
      // варианты с верной контрольной цифрой
      var numC = expandDigits(pre, 10).filter(function (c) { return checkDigit(c.slice(0, 9)) === c[9]; });
      var dobC = expandDigits(dobRaw, 7).filter(function (c) { return validYMD(c.slice(0, 6)) && checkDigit(c.slice(0, 6)) === c[6]; });
      var optAll = expandDigits(optRaw, 13).filter(function (c) { return validYMD(c.slice(1, 7)); });
      var optC = c3 ? optAll.filter(function (c) { return checkDigit(c + "<") === c3; }) : [];
      // итоговая контрольная цифра всей строки помогает выбрать один вариант
      if (comp && (numC.length > 1 || dobC.length > 1 || optC.length > 1)) {
        var combos = [];
        numC.forEach(function (n) { dobC.forEach(function (d) { optC.forEach(function (o) {
          if (checkDigit(n + d + "<<<<<<<" + o + "<" + c3) === comp) combos.push([n, d, o]);
        }); }); });
        if (combos.length === 1) { numC = [combos[0][0]]; dobC = [combos[0][1]]; optC = [combos[0][2]]; }
      }
      var num = numC.length ? numC[0] : (pre.length >= 9 ? pre.slice(-10).slice(0, 9) + "?" : "");
      var dobS = dobC.length ? dobC[0] : dobRaw;
      var opt = optC.length ? optC[0] : (optAll[0] || "");
      if (/^\d{9}/.test(num)) {
        res.found = true;
        var okNum = numC.length === 1, okOpt = optC.length === 1;
        res.fields.passNumber = num.slice(3, 9); res.ok.passNumber = okNum;
        if (/^\d/.test(opt)) { res.fields.passSeries = num.slice(0, 3) + opt[0]; res.ok.passSeries = okNum && okOpt; }
        var d = yymmdd(dobS.slice(0, 6)); if (d) { res.fields.dob = d; res.ok.dob = dobC.length === 1; }
        var iss = opt ? yymmdd(opt.slice(1, 7)) : ""; if (iss) { res.fields.passIssueDate = iss; res.ok.passIssueDate = okOpt; }
        if (/^\d{6}$/.test(opt.slice(7, 13))) { res.fields.passCode = opt.slice(7, 10) + "-" + opt.slice(10, 13); res.ok.passCode = okOpt; }
        if (sex === "M" || sex === "F") res.fields.sex = sex;
        // если вариантов несколько — отдадим их, чтобы сверить с напечатанным текстом
        if (optC.length > 1) res.optAlts = optC.map(function (o) { return { series: num.slice(0, 3) + o[0], issue: yymmdd(o.slice(1, 7)), code: o.slice(7, 10) + "-" + o.slice(10, 13) }; });
      }
    }
    if (l1) {
      var after = l1.replace(/^P[N<A-Z]?RU[S5]/, "");
      var cut = after.indexOf("<<");
      if (cut > 0) {
        var sur = after.slice(0, cut).replace(/</g, "");
        var rest = after.slice(cut + 2).split("<").filter(function (p) { return p.length >= 2 && !/^[KCLXE]{3,}$/.test(p); });
        // заполнитель «<», прочитанный как K/C/L, прилип к отчеству: режем после типового окончания
        if (rest[1]) { var pm = /^(.*?(?:VI3|I3|VNA|3NA|OGLY|KYZY))[KCLXE]+$/.exec(rest[1]); if (pm) rest[1] = pm[1]; }
        var fio = [decodeName(sur), decodeName(rest[0] || ""), decodeName(rest[1] || "")].filter(Boolean).join(" ");
        if (fio.split(" ").length >= 2) { res.found = true; res.fields.fio = fio; res.ok.fio = false; }
      }
    }
    return res;
  }

  /* ---------- печатный текст паспорта ---------- */
  // убирает «слова-мусор»: OCR машиночитаемой зоны кириллицей даёт длинные цепочки без пробелов
  function stripJunk(s) { return tidy(s).split(" ").filter(function (w) { return w.indexOf("-") >= 0 || w.length < 16; }).join(" ").trim(); }

  /* ---------- сверка ФИО из MRZ с печатным текстом ---------- */
  function lev(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 1; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  // ok=true только если КАЖДАЯ часть ФИО из MRZ дословно есть в печатном тексте (два независимых источника совпали)
  function reconcileFio(mrzFio, text, printedFio) {
    var letters = function (x) { return String(x || "").replace(/[^А-ЯЁ]/g, ""); };
    if (printedFio && printedFio.split(" ").length >= 2 && letters(printedFio) === letters(mrzFio)) return { fio: printedFio, ok: true };
    var set = {}; (String(text || "").toUpperCase().match(/[А-ЯЁ]{2,}/g) || []).forEach(function (w) { set[w] = 1; });
    var exact = true, out = String(mrzFio || "").split(" ").filter(Boolean).map(function (p) {
      if (set[p]) return p;
      exact = false;
      var best = null, bd = 9;
      for (var w in set) { if (Math.abs(w.length - p.length) > 2) continue; var dd = lev(p, w); if (dd < bd) { bd = dd; best = w; } }
      return best && bd <= 2 ? best : p;
    });
    return { fio: out.join(" "), ok: exact && out.length >= 2 };
  }


  /* ---------- словарь типовых слов: «РОССИ» → «РОССИИ», «ФОР.» → «ГОР.» ---------- */
  var VOCAB = ("РОССИИ РОССИЯ ОБЛАСТИ ОБЛАСТЬ САНКТ-ПЕТЕРБУРГУ САНКТ-ПЕТЕРБУРГ ЛЕНИНГРАДСКОЙ ЛЕНИНГРАДСКАЯ ЛЕНИНГРАД " +
    "МОСКВЕ МОСКВА МОСКОВСКОЙ МОСКОВСКАЯ ОТДЕЛОМ ОТДЕЛЕНИЕМ ОТДЕЛЕНИЯ ОТДЕЛА УПРАВЛЕНИЕМ УПРАВЛЕНИЯ МИЛИЦИИ ПОЛИЦИИ " +
    "РАЙОНА РАЙОНЕ РАЙОНУ РАЙОН ПЕТРОГРАДСКОГО ВЫБОРГСКОГО ВСЕВОЛОЖСКОГО ВСЕВОЛОЖСКИЙ ВСЕВОЛОЖСК КАЛИНИНСКОГО ПРИМОРСКОГО " +
    "НЕВСКОГО КРАСНОГВАРДЕЙСКОГО КИРОВСКОГО МОСКОВСКОГО ФРУНЗЕНСКОГО АДМИРАЛТЕЙСКОГО ЦЕНТРАЛЬНОГО ВАСИЛЕОСТРОВСКОГО " +
    "КРАСНОСЕЛЬСКОГО КОЛПИНСКОГО ПУШКИНСКОГО ПЕТРОДВОРЦОВОГО КУРОРТНОГО КРОНШТАДТСКОГО ФЕДЕРАЛЬНОЙ МИГРАЦИОННОЙ СЛУЖБЫ " +
    "ВНУТРЕННИХ ТЕРРИТОРИАЛЬНЫМ ПУНКТОМ ГОРОДА ГОРОДЕ ГОРОДУ РЕСПУБЛИКИ РЕСПУБЛИКА КРАЯ УЛИЦА ПРОСПЕКТ ПЕРЕУЛОК " +
    "КВАРТИРА КОРПУС СТРОЕНИЕ ЛИТЕРА ПОСЕЛОК ДЕРЕВНЯ ТЕРРИТОРИЯ ГУВМ УФМС").split(" ");
  var VOCAB_SET = {}; VOCAB.forEach(function (w) { VOCAB_SET[w] = 1; });
  var VOCAB_SHORT = { "ФОР.": "ГОР.", "Г0Р.": "ГОР.", "ГОР,": "ГОР.", "0БЛ.": "ОБЛ.", "ОБП.": "ОБЛ." };
  function fixVocab(text) {
    return String(text || "").split(" ").map(function (tok) {
      if (VOCAB_SHORT[tok]) return VOCAB_SHORT[tok];
      var m = /^([А-ЯЁ-]+)([.,]?)$/.exec(tok);
      if (!m || m[1].length < 5 || VOCAB_SET[m[1]]) return tok;
      // при равенстве — первое слово словаря (родительный падеж стоит первым: «ГУ МВД РОССИИ ПО … ОБЛАСТИ»)
      for (var i = 0; i < VOCAB.length; i++) if (Math.abs(VOCAB[i].length - m[1].length) <= 1 && lev(m[1], VOCAB[i]) <= 1) return VOCAB[i] + m[2];
      return tok;
    }).join(" ");
  }

  function tidy(s) { return String(s).replace(/\s+/g, " ").replace(/[^А-ЯЁA-Z0-9 .,\-«»"()№/]/gi, "").replace(/^[\s.,\-]+|[\s,\-]+$/g, "").trim(); }
  function parsePassportText(t) {
    var U = String(t || "").toUpperCase(), f = {}, m;
    m = /ВЫДАН[А-Я]*\s*:?\s*([\s\S]{8,220}?)\s*(?:ДАТА\s*ВЫДАЧ|\d{2}[.,]\d{2}[.,]\d{4})/.exec(U);
    if (m) { var by = tidy(m[1]); if (by.length >= 6) f.passIssuedBy = by; }
    m = /ДАТА\s*ВЫДАЧИ\s*:?\s*(\d{2})[.,](\d{2})[.,](\d{4})/.exec(U); if (m) f.passIssueDate = m[1] + "." + m[2] + "." + m[3];
    m = /(?:КОД\s*ПОДРАЗДЕЛЕНИЯ\s*:?\s*)?(\d{3})\s*[-–—]\s*(\d{3})(?!\d)/.exec(U); if (m) f.passCode = m[1] + "-" + m[2];
    m = /ДАТА\s*РОЖДЕНИЯ\s*:?\s*(\d{2})[.,](\d{2})[.,](\d{4})/.exec(U); if (m) f.dob = m[1] + "." + m[2] + "." + m[3];
    m = /МЕСТО\s*РОЖДЕНИЯ\s*:?\s*\n?([\s\S]{3,120})/.exec(U);
    if (m) {
      var bl = m[1].split("\n").map(stripJunk).filter(function (x) { return x.length > 2 && !/ПОДПИСЬ|ЛИЧНЫЙ|КОД|ДАТА|<|ФАМИЛ|ОТЧЕСТВ/.test(x); });
      var bp = bl[0] || "";
      // вторая строка — только если это явно продолжение места рождения
      if (bl[1] && bl[1].length <= 40 && /(ОБЛ|Р-Н|РАЙОН|КРАЙ|РЕСП|Г\.|ГОР|ПОС|С\.|ДЕР|АССР|СССР|РОССИЯ)/.test(bl[1])) bp += " " + bl[1];
      if (bp.length >= 3) f.birthPlace = bp;
    }
    var fam = /ФАМИЛИЯ\s*:?\s*\n?\s*([А-ЯЁ\-]{2,})/.exec(U), im = /ИМЯ\s*:?\s*\n?\s*([А-ЯЁ\-]{2,})/.exec(U), ot = /ОТЧЕСТВО\s*:?\s*\n?\s*([А-ЯЁ\-]{2,})/.exec(U);
    if (fam && im) f.fio = [fam[1], im[1], ot ? ot[1] : ""].filter(Boolean).join(" ");
    return f;
  }

  /* ---------- прописка ---------- */
  var ADDR_KW = /(^|[\s.,])(Г\.|ГОР\.?|ГОРОД|УЛ\.?|УЛИЦА|ПР\.|ПР-КТ|ПРОСП|ПРОСПЕКТ|Д\.|ДОМ|КВ\.?|КВАРТИРА|КОРП|К\.|ОБЛ|ОБЛАСТЬ|Р-Н|РАЙОН|ПОС|ПОСЕЛОК|СНТ|ДЕР|ДЕРЕВНЯ|ПЕР\.?|ПЕРЕУЛОК|НАБ|Ш\.|ШОССЕ|БУЛ|МКР|СТР|ЛИТ|РЕСП|КРАЙ|ТЕР|ПГТ|САНКТ-ПЕТЕРБУРГ|МОСКВА)/;
  var ADDR_STOP = /(ЗАРЕГИСТРИРОВАН|МЕСТО\s*ЖИТЕЛЬСТВА|ОТДЕЛ|МВД|УФМС|ГУВМ|ПОДПИСЬ|ДОЛЖНОСТН|СНЯТ|ВОИНСК|РЕГИСТРАЦ|ВЫДАН|ПАСПОРТ)/;
  function parseRegistration(t) {
    var lines = String(t || "").toUpperCase().split("\n").map(function (s) { return tidy(s); }).filter(function (s) { return s.length >= 3; });
    var cand = lines.filter(function (l) { return ADDR_KW.test(l) && !ADDR_STOP.test(l); });
    return { address: cand.join(", ").replace(/\s*,\s*,/g, ","), lines: lines };
  }

  /* ---------- водительское удостоверение ---------- */
  function toD(s) { var m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s); return m ? { s: s, d: +m[1], m: +m[2], y: +m[3], t: Date.UTC(+m[3], +m[2] - 1, +m[1]) } : null; }
  function parseLicense(t, knownDob) {
    var U = String(t || "").toUpperCase(), f = {}, m;
    m = /(?:^|[^\d.])(\d{2})\s?(\d{2})\s?(\d{6})(?![\d.])/.exec(U);
    if (m) f.licNumber = m[1] + " " + m[2] + " " + m[3];
    var dates = [], re = /(\d{2})[.,](\d{2})[.,](\d{4})/g;
    while ((m = re.exec(U))) { var x = toD(m[1] + "." + m[2] + "." + m[3]); if (x && x.m >= 1 && x.m <= 12) dates.push(x); }
    var seen = {}; dates = dates.filter(function (x) { if (seen[x.s]) return false; seen[x.s] = 1; return true; }).sort(function (a, b) { return a.t - b.t; });
    var dob = null;
    if (knownDob) dob = dates.filter(function (x) { return x.s === knownDob; })[0] || null;
    if (!dob && dates.length >= 3) dob = dates[0];
    if (dob) f.dob = dob.s;
    var rest = dates.filter(function (x) { return x !== dob; });
    var pair = null;
    for (var i = 0; i < rest.length && !pair; i++) for (var j = i + 1; j < rest.length; j++) if (rest[j].y === rest[i].y + 10 && rest[j].m === rest[i].m && Math.abs(rest[j].d - rest[i].d) <= 1) { pair = rest[i]; break; }
    if (pair) f.licIssueDate = pair.s; else if (rest.length >= 2) f.licIssueDate = rest[0].s;
    m = /ГИБДД\s*:?\s*(\d{4})/.exec(U); if (m) f.licIssuedBy = "ГИБДД " + m[1];
    var a = /(?:^|\n)\s*1[.,]?\s*([А-ЯЁ\-]{2,})/.exec(U), b = /(?:^|\n)\s*2[.,]?\s*([А-ЯЁ\-]{2,})\s+([А-ЯЁ\-]{2,})/.exec(U);
    if (a && b) f.fio = a[1] + " " + b[1] + " " + b[2];
    return f;
  }

  /* ---------- подготовка изображения ---------- */
  // src — файл с камеры или уже обрезанный canvas; color=true — без перевода в ч/б (для нейросети)
  async function prepImage(src, rot, crop, color) {
    var bmp = null, isCanvas = typeof HTMLCanvasElement !== "undefined" && src instanceof HTMLCanvasElement;
    if (isCanvas) bmp = src;
    else {
      if (typeof createImageBitmap === "function") {
        try { bmp = await createImageBitmap(src, { imageOrientation: "from-image" }); } catch (e) { try { bmp = await createImageBitmap(src); } catch (e2) { bmp = null; } }
      }
      if (!bmp) { // запасной путь для старых iPhone/Safari
        var url = URL.createObjectURL(src), img = new Image();
        img.src = url;
        await (img.decode ? img.decode() : new Promise(function (ok, bad) { img.onload = ok; img.onerror = bad; }));
        URL.revokeObjectURL(url); bmp = img;
      }
    }
    var w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height, r = ((rot || 0) % 360 + 360) % 360, swap = r === 90 || r === 270;
    var scale = Math.min(1, 2200 / Math.max(w, h));
    var cw = Math.round((swap ? h : w) * scale), ch = Math.round((swap ? w : h) * scale);
    var c = document.createElement("canvas"); c.width = cw; c.height = ch;
    var x = c.getContext("2d"); x.translate(cw / 2, ch / 2); x.rotate(r * Math.PI / 180); x.drawImage(bmp, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
    if (!isCanvas && bmp.close) bmp.close();
    var out = c;
    if (crop) {
      var y0 = Math.round(ch * crop.y0), y1 = Math.round(ch * crop.y1), up = crop.up || 1;
      var cc = document.createElement("canvas"); cc.width = Math.round(cw * up); cc.height = Math.round((y1 - y0) * up);
      cc.getContext("2d").drawImage(c, 0, y0, cw, y1 - y0, 0, 0, cc.width, cc.height); out = cc;
    }
    if (color) return out;
    var ctx = out.getContext("2d"), im = ctx.getImageData(0, 0, out.width, out.height), d = im.data, hist = new Uint32Array(256), i;
    for (i = 0; i < d.length; i += 4) { var lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = lum; hist[lum]++; }
    var total = d.length / 4, lo = 0, hi = 255, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
    acc = 0; for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
    var span = Math.max(1, hi - lo);
    for (i = 0; i < d.length; i += 4) { var v = (d[i] - lo) * 255 / span; v = v < 0 ? 0 : v > 255 ? 255 : v; d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(im, 0, 0);
    return out;
  }

  /* ---------- движок Tesseract ---------- */
  var TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  var wRus = null, wMrz = null, onProg = null;
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = function () { rej(new Error("Нет интернета или CDN недоступен — модель распознавания не загрузилась.")); }; document.head.appendChild(s); }); }
  var STAGE = { "loading tesseract core": "Загружаю движок…", "initializing tesseract": "Запускаю движок…", "loading language traineddata": "Загружаю словарь (только в первый раз)…", "initializing api": "Готовлю распознавание…", "recognizing text": "Читаю текст…" };
  async function init() {
    if (wRus && wMrz) return;
    if (!root.Tesseract) await loadScript(TESS_URL);
    var logger = function (m) { if (onProg && m && m.status) onProg(STAGE[m.status] || m.status, typeof m.progress === "number" ? m.progress : null); };
    if (!wRus) wRus = await root.Tesseract.createWorker("rus", 1, { logger: logger });
    if (!wMrz) { wMrz = await root.Tesseract.createWorker("eng", 1, { logger: logger }); await wMrz.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<", tessedit_pageseg_mode: "6" }); }
  }
  async function readRus(canvas) { return (await wRus.recognize(canvas)).data.text || ""; }
  async function readMrz(canvas) { return (await wMrz.recognize(canvas)).data.text || ""; }

  // photos: {passport:{canvas|file,rot}, reg:…, lic:…}; step(label, fraction)
  // Сначала нейросеть PaddleOCR (точнее), при сбое — Tesseract.
  async function scan(photos, step) {
    var out = { fields: {}, ok: {}, regLines: [], notes: [], engine: "paddle" };
    function put(src, okmap) { for (var k in src) if (src[k] && !out.fields[k]) { out.fields[k] = src[k]; out.ok[k] = !!(okmap && okmap[k]); } }
    function has(ph) { return ph && (ph.canvas || ph.file); }
    function src(ph) { return ph.canvas || ph.file; }
    function rot(ph) { return ph.canvas ? 0 : ph.rot; }
    step("Подготовка…", 0.02);
    if (root.Paddle) {
      try { await root.Paddle.init(step); }
      catch (e) { out.engine = "tess"; out.notes.push("Нейросеть не загрузилась (" + (e && e.message || e) + ") — использован простой движок."); }
    } else out.engine = "tess";
    if (out.engine === "tess") { onProg = function (label, p) { step(label, p); }; await init(); }

    async function read(ph, label, crop) {
      step(label, null);
      if (out.engine === "paddle") {
        var r = await root.Paddle.recognize(await prepImage(src(ph), rot(ph), crop, true), function (l, p) { step(label + " " + l.replace(/^[^…]*… ?/, ""), p); });
        return { text: fixMixedScript(r.text), raw: r.text };
      }
      var t = await readRus(await prepImage(src(ph), rot(ph), crop));
      return { text: t, raw: t };
    }

    if (has(photos.passport)) {
      var P = photos.passport, rp = await read(P, "Читаю паспорт…"), mrz = parseMRZ(rp.raw);
      if (!mrz.found) { // вторая попытка: нижняя часть разворота крупнее
        step("Ищу машиночитаемую зону паспорта…", null);
        if (out.engine === "paddle") mrz = parseMRZ((await read(P, "Ищу строки <<< внизу паспорта…", { y0: 0.6, y1: 1, up: 1.6 })).raw);
        else mrz = parseMRZ(await readMrz(await prepImage(src(P), rot(P), { y0: 0.62, y1: 1, up: 1 })));
      }
      var pt = parsePassportText(rp.text);
      if (pt.passIssuedBy) pt.passIssuedBy = fixVocab(pt.passIssuedBy);
      if (pt.birthPlace) pt.birthPlace = fixVocab(pt.birthPlace);
      if (mrz.fields.fio) { var rc = reconcileFio(mrz.fields.fio, rp.text, pt.fio); mrz.fields.fio = rc.fio; mrz.ok.fio = rc.ok; }
      if (mrz.optAlts && (pt.passCode || pt.passIssueDate)) { // несколько вариантов — выбираем совпавший с напечатанным
        var hit = mrz.optAlts.filter(function (a) { return (!pt.passCode || a.code === pt.passCode) && (!pt.passIssueDate || a.issue === pt.passIssueDate); });
        if (hit.length === 1) { mrz.fields.passSeries = hit[0].series; mrz.fields.passIssueDate = hit[0].issue; mrz.fields.passCode = hit[0].code;
          mrz.ok.passSeries = mrz.ok.passNumber; mrz.ok.passIssueDate = true; mrz.ok.passCode = true; }
      }
      put(mrz.fields, mrz.ok); put(pt, null);
      if (!mrz.found) out.notes.push("Машиночитаемая зона паспорта не найдена — сфотографируй разворот целиком, вместе с двумя строками «<<<» внизу, ровно и без бликов.");
    }
    if (has(photos.reg)) {
      var rg = parseRegistration((await read(photos.reg, "Читаю прописку…")).text);
      out.regLines = rg.lines; if (rg.address) put({ address: fixVocab(rg.address) }, null);
    }
    if (has(photos.lic)) {
      put(parseLicense((await read(photos.lic, "Читаю водительское удостоверение…")).text, out.fields.dob), null);
    }
    step("Готово", 1);
    return out;
  }

  var api = { fixVocab: fixVocab, expandDigits: expandDigits, fixMixedScript: fixMixedScript, reconcileFio: reconcileFio, parseMRZ: parseMRZ, parsePassportText: parsePassportText, parseRegistration: parseRegistration, parseLicense: parseLicense, checkDigit: checkDigit, decodeName: decodeName, RU_MRZ: RU_MRZ, scan: scan, prepImage: prepImage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OCR = api;
})(typeof window !== "undefined" ? window : globalThis);
