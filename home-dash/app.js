/* Dashboard (static, client-side decrypted). Data blobs are AES-GCM encrypted; key derived from the password with PBKDF2-SHA256. */
(function () {
  "use strict";
  var TZ = "America/New_York";
  var ORDER = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
  var LIVE = ["r0", "r1", "r2", "r3"];
  var INDOOR = ["r0", "r1", "r2", "r3", "r4", "r5"];
  var UTIL = ["r7", "r6"];
  var PALETTE = { r0: "#2563eb", r1: "#ca8a04", r2: "#ea580c", r3: "#16a34a", r4: "#7c3aed", r5: "#0891b2", r6: "#db2777", r7: "#6b7280", indoor: "#0f766e" };
  var COMFORT = { temp: [68, 74], hum: [30, 60] };
  var RANGES = [["24h", "24 hours"], ["3d", "3 days"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All"], ["year", "Past year"], ["custom", "Custom"]];
  var METRICS = [["temp", "Temperature"], ["hum", "Humidity"], ["dew", "Dewpoint"], ["vpd", "VPD"]];
  var REFRESH_MS = 5 * 60 * 1000;
  var SHORT_MAX = 31 * 86400 + 3600; // ranges up to this use per-day minute files; longer ones use 6-hour points

  function load(k, d) { try { var v = JSON.parse(localStorage.getItem("hsd." + k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem("hsd." + k, JSON.stringify(v)); } catch (e) {} }

  var S = {
    metric: load("metric", "temp"), range: load("range", "3d"), smooth: load("smooth", true), heat: load("heat", true), comfort: load("comfort", true),
    rooms: load("rooms", LIVE.slice()).filter(function (k) { return ORDER.indexOf(k) >= 0; }), custom: load("custom", null), dailyRoom: load("dailyRoom", "r2"),
    summary: null, lastLoad: 0, charts: [], names: {}
  };
  if (!S.custom) { var d0 = etDate(Date.now() / 1000 - 7 * 86400), d1 = etDate(Date.now() / 1000); S.custom = { from: d0, to: d1 }; }

  // ---------- time helpers ----------
  var fmtCache = {};
  function parts(sec) {
    var f = fmtCache.p || (fmtCache.p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short", weekday: "short" }));
    var o = {}; f.formatToParts(new Date(sec * 1000)).forEach(function (p) { if (p.type !== "literal") o[p.type] = p.value; }); return o;
  }
  function fmt(sec, kind) {
    if (sec == null) return "—";
    var p = parts(sec), tz = p.timeZoneName || "ET";
    if (kind === "date") return p.month + " " + p.day;
    if (kind === "wdate") return p.weekday + ", " + p.month + " " + p.day;
    if (kind === "time") return p.hour + ":" + p.minute + " " + p.dayPeriod + " " + tz;
    if (kind === "short") return p.month + " " + p.day + ", " + p.hour + ":" + p.minute + " " + p.dayPeriod;
    return p.month + " " + p.day + ", " + p.hour + ":" + p.minute + " " + p.dayPeriod + " " + tz;
  }
  function etDate(sec) { var f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }); return f.format(new Date(sec * 1000)); }
  function tzOffset(sec) { // seconds ET is ahead of UTC at instant sec (negative)
    var o = {}; new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(sec * 1000)).forEach(function (p) { o[p.type] = +p.value; });
    return Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) / 1000 - Math.floor(sec);
  }
  function etMidnight(dstr) { var a = dstr.split("-").map(Number), u = Date.UTC(a[0], a[1] - 1, a[2]) / 1000; return u - tzOffset(u + 43200); }
  function nextDay(dstr) { var a = dstr.split("-").map(Number); return new Date(Date.UTC(a[0], a[1] - 1, a[2] + 1)).toISOString().slice(0, 10); }
  function ago(s) { if (s == null) return ""; if (s < 90) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400 * 2) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + " h ago"; return Math.round(s / 86400) + " days ago"; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function $(id) { return document.getElementById(id); }

  // ---------- science ----------
  function dewF(tf, rh) { var t = (tf - 32) * 5 / 9, g = Math.log(Math.max(rh, 0.1) / 100) + 17.62 * t / (243.12 + t); return 243.12 * g / (17.62 - g) * 9 / 5 + 32; }
  function vpd(tf, rh) { var t = (tf - 32) * 5 / 9; return 0.6108 * Math.exp(17.27 * t / (t + 237.3)) * (1 - rh / 100); }
  function metricArr(m, s) {
    if (m === "temp") return s.t.slice(); if (m === "hum") return s.h.slice();
    return s.t.map(function (t, i) { var h = s.h[i]; if (t == null || h == null) return null; return m === "dew" ? dewF(t, h) : vpd(t, h); });
  }
  function fmtVal(m, v, tick) { if (v == null || !isFinite(v)) return "—"; if (m === "hum") return v.toFixed(tick ? 0 : 1) + "%"; if (m === "vpd") return v.toFixed(tick ? 1 : 2) + (tick ? "" : " kPa"); return v.toFixed(tick ? 0 : 1) + "°" + (tick ? "" : "F"); }
  function smoothArr(arr, w) {
    var h = Math.floor(w / 2), out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] == null) { out[i] = null; continue; }
      var sum = 0, n = 0;
      for (var j = i - h; j <= i + h; j++) { if (j < 0 || j >= arr.length) continue; if (arr[j] == null) { if (j < i) { sum = 0; n = 0; continue; } else break; } sum += arr[j]; n++; }
      out[i] = n ? sum / n : arr[i];
    }
    return out;
  }
  function smoothWindow(step) { return step <= 1 ? 9 : step <= 10 ? 5 : 3; }

  // ---------- range ----------
  function windowFor() {
    var now = Date.now() / 1000, r = S.range;
    if (r === "24h") return [now - 86400, now];
    if (r === "3d") return [now - 3 * 86400, now];
    if (r === "7d") return [now - 7 * 86400, now];
    if (r === "30d") return [now - 30 * 86400, now];
    if (r === "year") return [now - 365 * 86400, now];
    if (r === "all") return [S.summary && S.summary.first ? S.summary.first : now - 400 * 86400, now];
    var a = etMidnight(S.custom.from), b = etMidnight(nextDay(S.custom.to));
    if (b <= a) b = a + 86400; return [a, Math.min(b, now + 60)];
  }
  function rangeLabel() {
    var w = windowFor(); if (S.range === "custom") return fmt(w[0], "date") + " – " + fmt(w[1] - 1, "date");
    var o = RANGES.filter(function (r) { return r[0] === S.range; })[0]; return o ? o[1] : S.range;
  }

  // ---------- crypto + static data layer ----------
  var KEY = null, MAN = null, BLOBS = {}, KJSON = null;
  var SKEY = "hsd.key";
  function b64(buf) { var s = "", b = new Uint8Array(buf); for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function unb64(s) { var r = atob(s), b = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) b[i] = r.charCodeAt(i); return b; }
  function hex2buf(h) { var b = new Uint8Array(h.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
  function getBin(path, bust) {
    return fetch(path + (bust ? "?v=" + encodeURIComponent(bust) : ""), { cache: "no-store", credentials: "omit" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); });
  }
  function kjson() { return fetch("data/k.json?t=" + Date.now(), { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }
  function decrypt(key, buf) {
    var u = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, key, u.slice(12)).then(function (pt) {
      var ds = new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(ds).text();
    }).then(JSON.parse);
  }
  function deriveKey(pw, k) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]).then(function (base) {
      return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hex2buf(k.salt), iterations: k.iter }, base, 256);
    });
  }
  function importRaw(raw) { return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]); }
  function loadManifest() {
    return getBin("data/m.bin", String(Date.now())).then(function (buf) { return decrypt(KEY, buf); }).then(function (m) { MAN = m; return m; });
  }
  function blob(ent) { // ent {f,h}; h === "live" => always refetch
    var id = ent.f + "|" + ent.h;
    if (ent.h !== "live" && BLOBS[id]) return BLOBS[id];
    var p = getBin("data/" + ent.f, ent.h === "live" ? String(Date.now()) : ent.h).then(function (buf) { return decrypt(KEY, buf); });
    if (ent.h !== "live") { BLOBS[id] = p; p.catch(function () { delete BLOBS[id]; }); }
    return p;
  }
  function decodeSeries(e) {
    var n = e.x.length + 1, x = new Array(n), t = new Array(n), h = new Array(n), cx = e.x0, ct = 0, ch = 0;
    x[0] = cx; for (var i = 1; i < n; i++) { cx += e.x[i - 1]; x[i] = cx; }
    for (i = 0; i < n; i++) { var dt = e.t[i], dh = e.h[i]; if (dt == null) t[i] = NaN; else { ct += dt; t[i] = ct / 100; } if (dh == null) h[i] = NaN; else { ch += dh; h[i] = ch / 100; } }
    return { x: x, t: t, h: h };
  }
  var DECODED = {};
  function dayData(d) { // -> {room: {x,t,h}} decoded raw readings for local day d
    var ent = MAN.days[d]; if (!ent) return Promise.resolve({});
    var id = ent.f + "|" + ent.h;
    if (ent.h !== "live" && DECODED[id]) return Promise.resolve(DECODED[id]);
    return blob(ent).then(function (c) { var o = {}; Object.keys(c.r).forEach(function (k) { o[k] = decodeSeries(c.r[k]); }); if (ent.h !== "live") DECODED[id] = o; return o; });
  }
  function daysBetween(a, b) { var out = [], d = etDate(a), e = etDate(b); while (d <= e && out.length < 800) { out.push(d); d = nextDay(d); } return out; }
  function rawRange(rooms, start, end) {
    return Promise.all(daysBetween(start, end).map(dayData)).then(function (list) {
      var out = {};
      rooms.forEach(function (k) {
        var x = [], t = [], h = [];
        list.forEach(function (dd) { var s = dd[k]; if (!s) return; for (var i = 0; i < s.x.length; i++) { if (s.x[i] < start || s.x[i] > end) continue; x.push(s.x[i]); t.push(s.t[i]); h.push(s.h[i]); } });
        if (x.length) out[k] = { x: x, t: t, h: h };
      });
      return out;
    });
  }
  var NICE = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
  function pickStep(span) { var want = span / 60 / 1500; for (var i = 0; i < NICE.length; i++) if (NICE[i] >= want) return NICE[i]; return 1440; }
  function r2(v) { return Math.round(v * 100) / 100; }
  // grid: {g0, step, n, t:[], h:[], c:[]} (means; NaN when empty)
  function gridFromRaw(s, g0, step, n) {
    var st = new Float64Array(n), ct = new Float64Array(n), sh = new Float64Array(n), chh = new Float64Array(n), c = new Float64Array(n);
    for (var i = 0; i < s.x.length; i++) { var j = Math.floor((s.x[i] - g0) / step); if (j < 0 || j >= n) continue; c[j]++; if (!isNaN(s.t[i])) { st[j] += s.t[i]; ct[j]++; } if (!isNaN(s.h[i])) { sh[j] += s.h[i]; chh[j]++; } }
    var t = [], h = [], cc = []; for (j = 0; j < n; j++) { t.push(ct[j] ? st[j] / ct[j] : NaN); h.push(chh[j] ? sh[j] / chh[j] : NaN); cc.push(c[j]); }
    return { t: t, h: h, c: cc };
  }
  function packPoints(g0, step, gt, gh, present, start, end) {
    var gap = Math.max(3 * step, 7200), xs = [], ts = [], hs = [], prev = null;
    for (var i = 0; i < gt.length; i++) {
      if (!present[i]) continue; var x = g0 + i * step; if (x + step <= start || x > end) continue;
      if (prev != null && x - prev > gap) { xs.push(prev + step); ts.push(null); hs.push(null); }
      xs.push(x); ts.push(isNaN(gt[i]) ? null : r2(gt[i])); hs.push(isNaN(gh[i]) ? null : r2(gh[i])); prev = x;
    }
    return { x: xs, t: ts, h: hs };
  }
  function indoorAvg(grids) {
    var ks = INDOOR.filter(function (k) { return grids[k]; }); if (!ks.length) return null;
    var n = grids[ks[0]].t.length, t = [], h = [];
    for (var i = 0; i < n; i++) { var st = 0, nt = 0, sh = 0, nh = 0; ks.forEach(function (k) { var a = grids[k].t[i], b = grids[k].h[i]; if (!isNaN(a)) { st += a; nt++; } if (!isNaN(b)) { sh += b; nh++; } }); t.push(nt ? st / nt : NaN); h.push(nh ? sh / nh : NaN); }
    return { t: t, h: h };
  }
  function seriesData(rooms, start, end, wantIndoor) {
    var span = Math.max(60, end - start), need = rooms.slice();
    if (wantIndoor) INDOOR.forEach(function (k) { if (need.indexOf(k) < 0) need.push(k); });
    if (span <= SHORT_MAX) {
      var stepMin = pickStep(span), step = stepMin * 60, g0 = Math.floor(start / step) * step, n = Math.ceil((end - g0) / step) + 1;
      return rawRange(need, start - step, end).then(function (raw) {
        var out = { step: stepMin, start: start, end: end, series: {} }, grids = {};
        need.forEach(function (k) { if (!raw[k]) return; var g = gridFromRaw(raw[k], g0, step, n); grids[k] = g; if (rooms.indexOf(k) >= 0) out.series[k] = packPoints(g0, step, g.t, g.h, g.c.map(function (c) { return c > 0; }), start, end); });
        if (wantIndoor) { var ia = indoorAvg(grids); if (ia) out.series.indoor = packPoints(g0, step, ia.t, ia.h, ia.t.map(function (v) { return !isNaN(v); }), start, end); }
        return out;
      });
    }
    // long range: 6-hour buckets from the year file, plus today's minute file bucketed the same way
    var stepMin2 = Math.max(360, pickStep(span)), step2 = stepMin2 * 60;
    return Promise.all([blob(MAN.year), dayData(etDate(Date.now() / 1000))]).then(function (r) {
      var Y = r[0], today = r[1], YS = Y.step, g0 = Math.floor(start / step2) * step2, n = Math.ceil((end - g0) / step2) + 1;
      var out = { step: stepMin2, start: start, end: end, series: {} }, grids = {};
      need.forEach(function (k) {
        var st = new Float64Array(n), ct = new Float64Array(n), sh = new Float64Array(n), chh = new Float64Array(n), any = false;
        function add(ts, tv, tn, hv, hn) { var j = Math.floor((ts - g0) / step2); if (j < 0 || j >= n) return; if (tv != null && tn) { st[j] += tv * tn; ct[j] += tn; any = true; } if (hv != null && hn) { sh[j] += hv * hn; chh[j] += hn; any = true; } }
        var b = Y.b[k];
        if (b) { var idx = 0; for (var i = 0; i < b.i.length; i++) { idx += b.i[i]; add(idx * YS, b.t[i], b.nt[i], b.h[i], b.nh[i]); } }
        var td = today[k];
        if (td) for (var q = 0; q < td.x.length; q++) { if (td.x[q] < Y.cut) continue; add(Math.floor(td.x[q] / YS) * YS, isNaN(td.t[q]) ? null : td.t[q], 1, isNaN(td.h[q]) ? null : td.h[q], 1); }
        if (!any) return;
        var t = [], h = [], pres = []; for (var z = 0; z < n; z++) { t.push(ct[z] ? st[z] / ct[z] : NaN); h.push(chh[z] ? sh[z] / chh[z] : NaN); pres.push(ct[z] > 0 || chh[z] > 0); }
        grids[k] = { t: t, h: h };
        if (rooms.indexOf(k) >= 0) out.series[k] = packPoints(g0, step2, t, h, pres, start, end);
      });
      if (wantIndoor) { var ia = indoorAvg(grids); if (ia) out.series.indoor = packPoints(g0, step2, ia.t, ia.h, ia.t.map(function (v) { return !isNaN(v); }), start, end); }
      return out;
    });
  }
  function dailyFromRaw(s, d) {
    var tmin = null, tmax = null, tminAt = null, tmaxAt = null, ts = 0, tn = 0, hmin = null, hmax = null, hs = 0, hn = 0;
    for (var i = 0; i < s.x.length; i++) {
      var t = s.t[i], h = s.h[i];
      if (!isNaN(t)) { if (tmin == null || t < tmin) { tmin = t; tminAt = s.x[i]; } if (tmax == null || t > tmax) { tmax = t; tmaxAt = s.x[i]; } ts += t; tn++; }
      if (!isNaN(h)) { if (hmin == null || h < hmin) hmin = h; if (hmax == null || h > hmax) hmax = h; hs += h; hn++; }
    }
    function o(v) { return v == null ? null : Math.round(v * 10) / 10; }
    var row = { d: d, n: s.x.length, tmin: o(tmin), tmax: o(tmax), tavg: tn ? o(ts / tn) : null, hmin: o(hmin), hmax: o(hmax), havg: hn ? o(hs / hn) : null };
    if (tminAt != null) { row.tminAt = tminAt; row.tmaxAt = tmaxAt; }
    return row;
  }
  function dailyData(rooms, start, end) {
    var d0 = etDate(start), d1 = etDate(end), today = etDate(Date.now() / 1000);
    return Promise.all([blob(MAN.year), d1 >= today ? dayData(today) : Promise.resolve({})]).then(function (r) {
      var Y = r[0], td = r[1], out = {};
      rooms.forEach(function (k) {
        var rows = (Y.daily[k] || []).filter(function (x) { return x.d >= d0 && x.d <= d1; });
        if (td[k] && today >= d0 && !rows.some(function (x) { return x.d === today; })) rows.push(dailyFromRaw(td[k], today));
        out[k] = rows;
      });
      return out;
    });
  }
  function csvFor(rooms, start, end) {
    var raw = (end - start) <= 31 * 86400;
    function fx(sec) { var o = {}; new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(sec * 1000)).forEach(function (p) { o[p.type] = p.value; }); var off = tzOffset(sec) / 3600; return o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute + ":" + o.second + (off < 0 ? "-" : "+") + ("0" + Math.abs(off)).slice(-2) + ":00"; }
    var lines = ["time_local,time_utc,room,temperature_f,humidity_pct,dewpoint_f,vpd_kpa,bucket_minutes"];
    function emit(x, t, h, k, step) {
      if (t == null && h == null) return;
      var both = t != null && h != null;
      lines.push([fx(x), new Date(x * 1000).toISOString().replace(".000Z", "+00:00"), '"' + String(S.names[k] || k).replace(/"/g, '""') + '"', t == null ? "" : t, h == null ? "" : h, both ? r2(dewF(t, h)) : "", both ? Math.round(vpd(t, h) * 1000) / 1000 : "", step].join(","));
    }
    if (raw) return rawRange(rooms, start, end).then(function (d) { rooms.forEach(function (k) { var s = d[k]; if (!s) return; for (var i = 0; i < s.x.length; i++) emit(s.x[i], isNaN(s.t[i]) ? null : s.t[i], isNaN(s.h[i]) ? null : s.h[i], k, "raw"); }); return lines.join("\n") + "\n"; });
    return seriesData(rooms, start, end, false).then(function (d) { rooms.forEach(function (k) { var s = d.series[k]; if (!s) return; for (var i = 0; i < s.x.length; i++) emit(s.x[i], s.t[i], s.h[i], k, d.step); }); return lines.join("\n") + "\n"; });
  }

  // ---------- controls ----------
  function seg(opts, val, cb) {
    var d = document.createElement("div"); d.className = "seg";
    opts.forEach(function (o) { var b = document.createElement("button"); b.type = "button"; b.textContent = o[1]; if (o[0] === val) b.className = "on"; b.onclick = function () { cb(o[0]); }; d.appendChild(b); });
    return d;
  }
  function tog(label, val, cb) {
    var l = document.createElement("label"); l.className = "tog"; var i = document.createElement("input"); i.type = "checkbox"; i.checked = !!val; i.onchange = function () { cb(i.checked); }; l.appendChild(i); l.appendChild(document.createTextNode(label)); return l;
  }
  function renderControls() {
    document.querySelectorAll(".controls").forEach(function (c) {
      var forDetail = c.getAttribute("data-for") === "detail"; c.innerHTML = "";
      if (!forDetail) c.appendChild(seg(METRICS, S.metric, function (v) { S.metric = v; save("metric", v); renderControls(); drawHome(); }));
      c.appendChild(seg(RANGES, S.range, function (v) { S.range = v; save("range", v); renderControls(); reloadData(); }));
      var cu = document.createElement("span"); cu.className = "custom" + (S.range === "custom" ? " on" : "");
      cu.innerHTML = 'From <input type="date" class="cf"> to <input type="date" class="ct"> <button class="btn sm" type="button">Apply</button>';
      var max = etDate(Date.now() / 1000); cu.querySelector(".cf").value = S.custom.from; cu.querySelector(".ct").value = S.custom.to; cu.querySelector(".cf").max = max; cu.querySelector(".ct").max = max;
      cu.querySelector("button").onclick = function () { var f = cu.querySelector(".cf").value, t = cu.querySelector(".ct").value; if (!f || !t) return; if (t < f) { var x = f; f = t; t = x; } S.custom = { from: f, to: t }; save("custom", S.custom); renderControls(); reloadData(); };
      c.appendChild(cu);
      c.appendChild(tog("Smooth curve", S.smooth, function (v) { S.smooth = v; save("smooth", v); redraw(); }));
      c.appendChild(tog("Heating shading", S.heat, function (v) { S.heat = v; save("heat", v); redraw(); }));
      c.appendChild(tog("Comfort band", S.comfort, function (v) { S.comfort = v; save("comfort", v); redraw(); }));
    });
  }

  // ---------- charts ----------
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function destroyCharts() { S.charts.forEach(function (c) { try { c.u.destroy(); } catch (e) {} if (c.ro) c.ro.disconnect(); }); S.charts = []; }
  function sessionsAt(t) {
    var on = [false, false]; if (!S.summary) return on;
    S.summary.sessions.forEach(function (s) { if (t >= s.s && t <= s.e) on[s.floor] = true; }); return on;
  }
  function heatText(t) { var on = sessionsAt(t); return on[0] && on[1] ? "Both floors heating" : on[0] ? "1st floor heating" : on[1] ? "2nd floor heating" : ""; }

  function nearest(raw, xs, si, idx, tol) {
    var v = raw[si][idx]; if (v != null) return [v, xs[idx]];
    var t = xs[idx];
    for (var k = 1; k < 400; k++) {
      var l = idx - k, r = idx + k, okL = l >= 0 && t - xs[l] <= tol, okR = r < xs.length && xs[r] - t <= tol;
      if (!okL && !okR) break;
      if (okL && raw[si][l] != null) return [raw[si][l], xs[l]];
      if (okR && raw[si][r] != null) return [raw[si][r], xs[r]];
    }
    return [null, null];
  }

  /* defs: [{key,label,color,x,y}], opt: {metric, el, readout, height, sync, step, onCursor} */
  function makeChart(defs, opt) {
    var el = opt.el; el.innerHTML = "";
    defs = defs.filter(function (d) { return d.x && d.x.length; });
    if (!defs.length) { el.innerHTML = '<div class="cap" style="padding:30px 0;text-align:center">No readings in this range.</div>'; if (opt.readout) opt.readout.innerHTML = '<span class="muted">No data.</span>'; return null; }
    var w = smoothWindow(opt.step);
    var rawT = defs.map(function (d) { return [d.x, d.y]; });
    var smT = defs.map(function (d) { return [d.x, S.smooth ? smoothArr(d.y, w) : d.y]; });
    var raw = uPlot.join(rawT), data = uPlot.join(smT);
    var m = opt.metric, band = S.comfort ? COMFORT[m] : null;
    var fg2 = css("--fg2"), line = css("--line");
    var shades = [];
    if (S.heat && S.summary) {
      S.summary.sessions.forEach(function (s) { shades.push([s.s, s.e, s.floor === 0 ? "rgba(234,88,12,0.13)" : "rgba(37,99,235,0.12)"]); });
      S.summary.overlaps.forEach(function (s) { shades.push([s.s, s.e, "rgba(220,38,38,0.20)"]); });
    }
    var height = opt.height || (window.innerWidth < 600 ? 230 : 300);
    var uopts = {
      width: Math.max(260, el.clientWidth || 600), height: height,
      tzDate: function (ts) { return uPlot.tzDate(new Date(ts * 1e3), TZ); },
      legend: { show: false },
      cursor: { sync: opt.sync ? { key: opt.sync } : undefined, drag: { x: true, y: false, setScale: true }, points: { size: 7 }, focus: { prox: 30 } },
      focus: { alpha: 0.35 },
      scales: { x: { time: true, min: opt.min, max: opt.max }, y: { range: function (u, lo, hi) {
        if (lo == null || hi == null || !isFinite(lo)) return [0, 1];
        var pad = m === "vpd" ? 0.05 : m === "hum" ? 2 : 0.5;
        if (band && lo - band[0] < 12 && band[1] - hi < 12 && m !== "vpd") { lo = Math.min(lo, band[0] - pad); hi = Math.max(hi, band[1] + pad); }
        var span = Math.max(hi - lo, m === "vpd" ? 0.1 : 1); return [lo - span * 0.06, hi + span * 0.06];
      } } },
      axes: [
        { stroke: fg2, grid: { stroke: line, width: 1 }, ticks: { stroke: line }, font: "11px system-ui", space: 60 },
        { stroke: fg2, grid: { stroke: line, width: 1 }, ticks: { stroke: line }, font: "11px system-ui", size: m === "vpd" ? 44 : 40, values: function (u, vals) { return vals.map(function (v) { return fmtVal(m, v, true); }); } }
      ],
      series: [{}].concat(defs.map(function (d) { return { label: d.label, stroke: d.color, width: d.width || 1.7, points: { show: false }, spanGaps: false, fill: d.fill }; })),
      hooks: {
        drawClear: [function (u) {
          var ctx = u.ctx, bb = u.bbox; ctx.save();
          var x0 = u.scales.x.min, x1 = u.scales.x.max;
          shades.forEach(function (s) { if (s[1] < x0 || s[0] > x1) return; var a = u.valToPos(Math.max(s[0], x0), "x", true), b = u.valToPos(Math.min(s[1], x1), "x", true); ctx.fillStyle = s[2]; ctx.fillRect(a, bb.top, Math.max(1, b - a), bb.height); });
          if (band) { var ya = u.valToPos(band[1], "y", true), yb = u.valToPos(band[0], "y", true); var top = Math.max(bb.top, ya), bot = Math.min(bb.top + bb.height, yb); if (bot > top) { ctx.fillStyle = "rgba(22,163,74,0.09)"; ctx.fillRect(bb.left, top, bb.width, bot - top); ctx.strokeStyle = "rgba(22,163,74,0.35)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; [ya, yb].forEach(function (y) { if (y >= bb.top && y <= bb.top + bb.height) { ctx.beginPath(); ctx.moveTo(bb.left, y); ctx.lineTo(bb.left + bb.width, y); ctx.stroke(); } }); } }
          ctx.restore();
        }],
        setCursor: [function (u) { if (opt.onCursor) opt.onCursor(u, raw, defs); else readout(u, raw, defs, opt); }]
      }
    };
    var u = new uPlot(uopts, data, el);
    // touch: move the crosshair with a finger (horizontal), keep vertical page scroll
    var over = u.over;
    function touch(e) { var t = e.touches[0]; if (!t) return; var r = over.getBoundingClientRect(); u.setCursor({ left: Math.min(Math.max(0, t.clientX - r.left), r.width), top: Math.min(Math.max(0, t.clientY - r.top), r.height) }); }
    over.addEventListener("touchstart", touch, { passive: true }); over.addEventListener("touchmove", touch, { passive: true });
    over.addEventListener("dblclick", function () { u.setScale("x", { min: opt.min, max: opt.max }); });
    var ro = new ResizeObserver(function () { var wd = Math.max(260, el.clientWidth); if (Math.abs(wd - u.width) > 2) u.setSize({ width: wd, height: height }); });
    ro.observe(el);
    S.charts.push({ u: u, ro: ro });
    if (opt.readout) readout(u, raw, defs, opt);
    return u;
  }

  function readout(u, raw, defs, opt) {
    var el = opt.readout; if (!el) return;
    var idx = u.cursor.idx, m = opt.metric, xs = raw[0];
    var stepNote = opt.step > 1 ? " · " + (opt.step >= 60 ? opt.step / 60 + "-hour" : opt.step + "-min") + " average" : "";
    if (idx == null) { el.innerHTML = '<span class="muted">Hover or touch a chart for the exact time and value (unsmoothed). Drag to zoom, double-click to reset.</span>'; return; }
    var t = xs[idx], tol = Math.max(opt.step * 60 * 2.5, 1500), html = '<span class="t">' + esc(fmt(t, "full")) + '</span><span class="muted">' + esc(stepNote) + "</span>";
    defs.forEach(function (d, i) {
      var r = nearest(raw, xs, i + 1, idx, tol); if (r[0] == null) return;
      var off = r[1] !== t ? ' <span class="muted">(' + esc(fmt(r[1], "time").replace(/ E[SD]T$/, "")) + ")</span>" : "";
      html += '<span class="it"><span class="sw" style="background:' + d.color + '"></span>' + esc(d.label) + " <b>" + esc(fmtVal(m, r[0])) + "</b>" + off + "</span>";
    });
    var ht = heatText(t); if (ht) html += '<span class="badge heat">' + esc(ht) + "</span>";
    el.innerHTML = html;
  }

  // ---------- data loading ----------
  var DATA = { home: null, detail: null, daily: null, ddaily: null };
  function view() { var m = /room=([a-z0-9]+)/.exec(location.hash); return m && ORDER.indexOf(m[1]) >= 0 ? m[1] : "home"; }

  function loadSummary() {
    return loadManifest().then(function () { return blob(MAN.summary); }).then(function (s) {
      s.now = Date.now() / 1000;
      s.rooms.forEach(function (r) { S.names[r.k] = r.n; if (r.ts) { r.age_s = Math.max(0, Math.round(s.now - r.ts)); r.status = r.age_s > 12 * 3600 ? "offline" : r.age_s > 3600 ? "stale" : "ok"; } });
      s.gaps = (s.gaps || []).slice(); s.rooms.forEach(function (r) { if (r.ts && r.age_s >= 7200) s.gaps.unshift({ k: r.k, s: r.ts, e: null, h: Math.round(r.age_s / 360) / 10 }); });
      S.summary = s; S.lastLoad = Date.now(); setLive(true); renderSummary(); labelGroups();
    });
  }
  function reloadData() {
    var w = windowFor(), v = view();
    updateDownloads(w);
    if (v === "home") {
      var rooms = S.rooms.concat(UTIL).filter(function (x, i, a) { return a.indexOf(x) === i; });
      var p1 = seriesData(rooms, w[0], w[1], true).then(function (d) { DATA.home = d; drawHome(); });
      var p2 = dailyData([S.dailyRoom], w[0], w[1]).then(function (d) { DATA.daily = d; renderDaily(); });
      return Promise.all([p1, p2]);
    }
    var p3 = seriesData([v], w[0], w[1], false).then(function (d) { DATA.detail = d; drawDetail(); });
    var p4 = dailyData([v], w[0], w[1]).then(function (d) { DATA.ddaily = d; renderDetailTables(); });
    return Promise.all([p3, p4]);
  }
  function loadAll() {
    return loadSummary().then(reloadData).catch(function (e) { setLive(false, e); });
  }
  function redraw() { if (view() === "home") drawHome(); else drawDetail(); }

  // ---------- render: summary ----------
  function renderSummary() {
    var s = S.summary; if (!s) return;
    var latest = s.last, lastRoom = null; s.rooms.forEach(function (r) { if (r.ts === latest) lastRoom = r; });
    var zones = s.nest.zones || {}, zk = Object.keys(zones);
    var onZ = zk.filter(function (z) { return /heat/i.test(zones[z]); });
    var nestTxt = onZ.length === 2 ? "Both floors" : onZ.length === 1 ? (/1st/.test(onZ[0]) ? "1st floor" : "2nd floor") : "Off";
    var top = s.drops[0];
    var lastOv = s.overlaps[s.overlaps.length - 1];
    var M = [
      [Number(s.total).toLocaleString("en-US"), "Saved readings", s.first ? "since " + fmt(s.first, "date") + ", " + parts(s.first).year : ""],
      [fmt(latest, "time").replace(/ E[SD]T$/, ""), "Last reading", ago(s.now - latest)],
      [nestTxt, "Heating now", onZ.length ? "Nest zones calling for heat" : "both Nest zones idle"],
      [String(s.overlaps.length), "Both floors on", lastOv ? "latest " + fmt(lastOv.s, "short") : "overlap events"],
      [top ? top.drop.toFixed(1) + "°F" : "—", "Largest heat-start drop", top ? (S.names[top.k] || top.k) + ", " + fmt(top.s, "short") : ""]
    ];
    $("metrics").innerHTML = M.map(function (x) { return '<div class="metric"><div class="v">' + esc(x[0]) + '</div><div class="l">' + esc(x[1]) + '</div><div class="d">' + esc(x[2]) + "</div></div>"; }).join("");
    var warn = s.rooms.filter(function (r) { return r.status !== "ok"; });
    var co = '<div class="callout info"><b>Snapshot data.</b>This page is republished from the saved sensor readings about every 20 minutes between 6 AM and 11 PM Eastern (latest reading ' + esc(fmt(latest)) + '); it checks for a new copy every 5 minutes while open. Comfort shading is 68–74°F and 30–60% RH. Dewpoint and VPD are computed from temperature and humidity. Orange shading = 1st floor heating, blue = 2nd floor, red = both at once. The hover readout always shows unsmoothed values. Times are Eastern.</div>';
    if (warn.length) co += '<div class="callout warning"><b>Sensors not reporting.</b>' + warn.map(function (r) { return esc(r.n) + (r.ts ? " last reported " + esc(fmt(r.ts)) + " (" + esc(ago(r.age_s)) + ")" : " has no data"); }).join("; ") + ".</div>";
    $("callouts").innerHTML = co;
    $("nowCap").textContent = "Tap a room for a closer look. Stale after 1 hour without a reading; offline after 12 hours.";
    $("tiles").innerHTML = s.rooms.map(function (r) {
      var badge = r.status === "stale" ? '<span class="badge stale">Stale</span>' : r.status === "offline" ? '<span class="badge offline">Offline</span>' : r.status === "nodata" ? '<span class="badge nodata">No data</span>' : "";
      var out = [];
      if (r.status === "ok" && r.t != null && (r.t < 68 || r.t > 74) && INDOOR.indexOf(r.k) >= 0) out.push("outside 68–74°F");
      if (r.status === "ok" && r.h != null && (r.h < 30 || r.h > 60) && INDOOR.indexOf(r.k) >= 0) out.push("outside 30–60% RH");
      return '<div class="tile" role="button" tabindex="0" data-room="' + r.k + '"><div class="hd"><span class="nm"><span class="sw" style="background:' + PALETTE[r.k] + '"></span>' + esc(r.n) + "</span>" + badge + "</div>" +
        '<div class="big">' + (r.t != null ? r.t.toFixed(1) + "°F" : "—") + "</div>" +
        '<div class="s1">' + (r.h != null ? r.h.toFixed(0) + "% RH" : "—") + (r.dew != null ? " · dew " + r.dew.toFixed(0) + "°" : "") + (r.vpd != null ? " · " + r.vpd.toFixed(2) + " kPa" : "") + "</div>" +
        '<div class="s2">' + (r.ts ? esc(fmt(r.ts, "time")) + " · " + esc(ago(r.age_s)) : "") + "</div>" +
        (r.t24 ? '<div class="s2">24h: ' + r.t24[0].toFixed(1) + "–" + r.t24[1].toFixed(1) + "°F" + (r.h24 ? ", " + r.h24[0].toFixed(0) + "–" + r.h24[1].toFixed(0) + "%" : "") + "</div>" : "") +
        (out.length ? '<div class="s2" style="color:var(--warn)">' + esc(out.join(" · ")) + "</div>" : "") + "</div>";
    }).join("");
    $("tiles").querySelectorAll(".tile").forEach(function (t) {
      function go() { location.hash = "room=" + t.getAttribute("data-room"); }
      t.onclick = go; t.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
    // room toggles
    $("roomToggles").innerHTML = ORDER.map(function (k) { return '<span class="chip' + (S.rooms.indexOf(k) >= 0 ? " on" : "") + '" data-k="' + k + '" style="color:' + PALETTE[k] + '"><span class="sw" style="background:' + PALETTE[k] + '"></span><span style="color:var(--fg)">' + esc(S.names[k] || k) + "</span></span>"; }).join("");
    $("roomToggles").querySelectorAll(".chip").forEach(function (c) { c.onclick = function () { var k = c.getAttribute("data-k"), i = S.rooms.indexOf(k); if (i >= 0) S.rooms.splice(i, 1); else S.rooms.push(k); S.rooms.sort(function (a, b) { return ORDER.indexOf(a) - ORDER.indexOf(b); }); save("rooms", S.rooms); renderSummary(); reloadData(); }; });
    var sel = $("dailyRoom"); sel.innerHTML = ORDER.map(function (k) { return '<option value="' + k + '"' + (k === S.dailyRoom ? " selected" : "") + ">" + esc(S.names[k] || k) + "</option>"; }).join("");
    renderHeating();
    renderGaps();
    $("foot").textContent = "Read-only, encrypted snapshot. Published " + fmt(s.built) + ". Decrypted in this browser only.";
    if (view() !== "home") renderDetailStats();
  }

  function renderHeating() {
    var s = S.summary, zones = s.nest.zones || {};
    var names = Object.keys(zones).sort(function (a, b) { return /1st/.test(a) ? -1 : 1; });
    $("zones").innerHTML = names.map(function (z) {
      var on = /heat/i.test(zones[z]), open = s.nest.open && s.nest.open[z], last = s.nest.last && s.nest.last[z];
      var floor = /1st/.test(z) ? "1st floor" : "2nd floor";
      return '<div class="zone"><div class="zn">' + esc(floor) + " · " + esc(z.replace(/\s*\(.*\)/, "")) + ' Nest <span class="badge ' + (on ? "heat" : "ok") + '">' + (on ? "Heating" : esc(String(zones[z]).toLowerCase() === "off" ? "Idle" : zones[z])) + "</span></div>" +
        '<div class="zs">' + (on && open ? "Since " + esc(fmt(Date.parse(open) / 1000)) : last ? "Last update " + esc(fmt(last)) : "") + "</div></div>";
    }).join("") || '<div class="cap">No Nest state available.</div>';
    var since = s.now - 30 * 86400, f = [0, 0], c = [0, 0];
    s.sessions.forEach(function (x) { if (x.e >= since) { f[x.floor] += x.min; c[x.floor]++; } });
    $("heatCap").textContent = "Last 30 days: 1st floor " + c[0] + " sessions, " + Math.round(f[0]) + " min; 2nd floor " + c[1] + " sessions, " + Math.round(f[1]) + " min.";
    var mx = 1; s.heatDaily.forEach(function (d) { mx = Math.max(mx, d[1] + d[2]); });
    $("heatBars").innerHTML = s.heatDaily.map(function (d, i) {
      var dd = d[0].split("-"), lab = (i === 0 || dd[2] === "01") ? new Date(+dd[0], +dd[1] - 1, +dd[2]).toLocaleString("en-US", { month: "short" }) + " " + +dd[2] : String(+dd[2]);
      return '<div class="bar" title="' + esc(d[0] + ": 1st floor " + Math.round(d[1]) + " min, 2nd floor " + Math.round(d[2]) + " min") + '"><div class="stk" style="height:' + ((d[1] + d[2]) / mx * 110).toFixed(1) + 'px"><div class="a" style="flex:' + d[1] + '"></div><div class="b" style="flex:' + d[2] + '"></div></div><div class="lb">' + esc(lab) + "</div></div>";
    }).join("") + "";
    $("heatBars").insertAdjacentHTML("afterend", "");
    var ov = s.overlaps.slice().reverse();
    var bothNow = names.length === 2 && names.every(function (z) { return /heat/i.test(zones[z]); });
    $("ovlTbl").innerHTML = '<tr><th>Started</th><th>Ended</th><th class="n">Minutes</th></tr>' + (bothNow ? '<tr><td colspan="3"><span class="badge heat">Both floors heating right now</span></td></tr>' : "") +
      (ov.length ? ov.map(function (o) { return "<tr><td>" + esc(fmt(o.s)) + "</td><td>" + esc(fmt(o.e, "time")) + '</td><td class="n">' + o.min.toFixed(1) + "</td></tr>"; }).join("") : '<tr class="empty"><td colspan="3">None recorded</td></tr>');
    $("dropTbl").innerHTML = dropRows(s.drops);
  }
  function dropRows(list) {
    return '<tr><th>Room</th><th>Heat came on</th><th>Floor</th><th class="n">From</th><th class="n">Low</th><th class="n">Drop</th><th class="n">Min after</th></tr>' +
      (list.length ? list.map(function (d) { return "<tr><td>" + esc(S.names[d.k] || d.k) + "</td><td>" + esc(fmt(d.s)) + "</td><td>" + (d.floor === 0 ? "1st" : "2nd") + '</td><td class="n">' + d.from.toFixed(1) + '°</td><td class="n">' + d.low.toFixed(1) + '°</td><td class="n"><b>' + d.drop.toFixed(1) + '°</b></td><td class="n">' + d.after + "</td></tr>"; }).join("") : '<tr class="empty"><td colspan="7">No drops of 0.5°F or more</td></tr>');
  }
  function renderGaps() {
    var g = S.summary.gaps;
    $("gapTbl").innerHTML = '<tr><th>Room</th><th>Silent from</th><th>Until</th><th class="n">Hours</th></tr>' +
      (g.length ? g.map(function (x) { return "<tr><td>" + esc(S.names[x.k] || x.k) + "</td><td>" + esc(fmt(x.s)) + "</td><td>" + (x.e ? esc(fmt(x.e)) : '<span class="badge offline">still silent</span>') + '</td><td class="n">' + x.h.toFixed(1) + "</td></tr>"; }).join("") : '<tr class="empty"><td colspan="4">No gaps</td></tr>');
  }

  function dailyRows(rows) {
    rows = (rows || []).slice().reverse();
    return '<tr><th>Day</th><th class="n">Low °F</th><th>at</th><th class="n">High °F</th><th>at</th><th class="n">Avg °F</th><th class="n">Swing</th><th class="n">RH low</th><th class="n">RH high</th><th class="n">Readings</th></tr>' +
      (rows.length ? rows.map(function (r) {
        var sw = r.tmin != null && r.tmax != null ? (r.tmax - r.tmin).toFixed(1) : "—";
        return "<tr><td>" + esc(fmt(etMidnight(r.d) + 43200, "wdate")) + '</td><td class="n">' + (r.tmin != null ? r.tmin.toFixed(1) : "—") + "</td><td>" + (r.tminAt ? esc(fmt(r.tminAt, "time").replace(/ E[SD]T$/, "")) : "") + '</td><td class="n">' + (r.tmax != null ? r.tmax.toFixed(1) : "—") + "</td><td>" + (r.tmaxAt ? esc(fmt(r.tmaxAt, "time").replace(/ E[SD]T$/, "")) : "") + '</td><td class="n">' + (r.tavg != null ? r.tavg.toFixed(1) : "—") + '</td><td class="n">' + sw + '</td><td class="n">' + (r.hmin != null ? r.hmin.toFixed(0) + "%" : "—") + '</td><td class="n">' + (r.hmax != null ? r.hmax.toFixed(0) + "%" : "—") + '</td><td class="n">' + r.n + "</td></tr>";
      }).join("") : '<tr class="empty"><td colspan="10">No readings in this range</td></tr>');
  }
  function renderDaily() {
    var rows = DATA.daily && DATA.daily[S.dailyRoom];
    $("dailyCap").textContent = (S.names[S.dailyRoom] || "") + " · " + rangeLabel() + " · newest first";
    $("dailyTbl").innerHTML = dailyRows(rows);
  }

  // ---------- render: charts ----------
  function seriesDef(key, d, m, label) { return { key: key, label: label || S.names[key] || key, color: PALETTE[key], x: d.x, y: metricArr(m, d) }; }
  function drawHome() {
    destroyCharts(); var d = DATA.home; if (!d) return;
    var w = windowFor(), m = S.metric;
    var defs = S.rooms.filter(function (k) { return d.series[k]; }).map(function (k) { return seriesDef(k, d.series[k], m); });
    if (!S.rooms.length) { $("ch-compare").innerHTML = '<div class="cap" style="padding:30px 0;text-align:center">Turn on at least one room to plot it.</div>'; $("ro-compare").innerHTML = ""; }
    else makeChart(defs, { el: $("ch-compare"), readout: $("ro-compare"), metric: m, step: d.step, sync: "home", min: w[0], max: w[1] });
    $("note-compare").innerHTML = '<span class="k"><i style="background:rgba(234,88,12,.35)"></i>1st floor heating</span><span class="k"><i style="background:rgba(37,99,235,.35)"></i>2nd floor heating</span><span class="k"><i style="background:rgba(220,38,38,.45)"></i>both floors</span><span class="k"><i style="background:rgba(22,163,74,.3)"></i>comfort band</span><span>' + (d.step > 1 ? "Points are " + (d.step >= 60 ? d.step / 60 + "-hour" : d.step + "-minute") + " averages for this range." : "Minute-level readings.") + "</span>";
    var io = [];
    if (d.series.indoor) io.push(seriesDef("indoor", d.series.indoor, m, "Indoor average"));
    UTIL.forEach(function (k) { if (d.series[k]) io.push(seriesDef(k, d.series[k], m)); });
    makeChart(io, { el: $("ch-io"), readout: $("ro-io"), metric: m, step: d.step, sync: "home", min: w[0], max: w[1] });
  }

  function renderDetailStats() {
    var k = view(); if (k === "home" || !S.summary) return;
    var r = S.summary.rooms.filter(function (x) { return x.k === k; })[0]; if (!r) return;
    $("dTitle").innerHTML = '<span class="sw" style="background:' + PALETTE[k] + ';width:12px;height:12px;margin-right:8px"></span>' + esc(r.n) + (r.status === "stale" ? ' <span class="badge stale">Stale</span>' : r.status === "offline" ? ' <span class="badge offline">Offline</span>' : "");
    var st = [
      [r.t != null ? r.t.toFixed(1) + "°F" : "—", "Temperature", r.ts ? fmt(r.ts, "time") + " · " + ago(r.age_s) : ""],
      [r.h != null ? r.h.toFixed(1) + "%" : "—", "Humidity", r.h24 ? "24h " + r.h24[0].toFixed(0) + "–" + r.h24[1].toFixed(0) + "%" : ""],
      [r.dew != null ? r.dew.toFixed(1) + "°F" : "—", "Dewpoint", r.t24 ? "24h temp " + r.t24[0].toFixed(1) + "–" + r.t24[1].toFixed(1) + "°F" : ""],
      [r.vpd != null ? r.vpd.toFixed(2) + " kPa" : "—", "VPD", (r.count || 0).toLocaleString("en-US") + " saved readings"]
    ];
    $("dStats").innerHTML = st.map(function (x) { return '<div class="metric"><div class="v">' + esc(x[0]) + '</div><div class="l">' + esc(x[1]) + '</div><div class="d">' + esc(x[2]) + "</div></div>"; }).join("");
  }
  function drawDetail() {
    destroyCharts(); var k = view(), d = DATA.detail; if (!d || k === "home") return;
    var s = d.series[k], w = windowFor(), box = $("dCharts"); box.innerHTML = "";
    if (!s || !s.x.length) { box.innerHTML = '<div class="cap" style="padding:30px 0;text-align:center">No readings for this room in this range.</div>'; $("ro-detail").innerHTML = ""; return; }
    var made = [];
    METRICS.forEach(function (mm) {
      var wrap = document.createElement("div"); wrap.className = "dchart"; wrap.innerHTML = '<div class="lbl">' + esc(mm[1]) + (mm[0] === "vpd" ? " (kPa)" : mm[0] === "hum" ? " (% RH)" : " (°F)") + '</div><div class="chart"></div>'; box.appendChild(wrap);
      var def = seriesDef(k, s, mm[0], mm[1]); def.color = mm[0] === "temp" ? PALETTE[k] : mm[0] === "hum" ? "#0891b2" : mm[0] === "dew" ? "#7c3aed" : "#64748b";
      var u = makeChart([def], { el: wrap.querySelector(".chart"), metric: mm[0], step: d.step, sync: "detail", min: w[0], max: w[1], height: window.innerWidth < 600 ? 170 : 200, onCursor: function (uu, raw) { detailReadout(uu, raw, made); } });
      made.push({ u: u, m: mm[0], label: mm[1] });
    });
    detailReadout(null, null, made);
    function detailReadout(uu, raw, list) {
      var el = $("ro-detail"); var idx = uu ? uu.cursor.idx : null;
      if (idx == null) { el.innerHTML = '<span class="muted">Hover or touch a chart for the exact time and values (unsmoothed). Drag to zoom, double-click to reset. ' + (d.step > 1 ? "Points are " + (d.step >= 60 ? d.step / 60 + "-hour" : d.step + "-minute") + " averages." : "Minute-level readings.") + "</span>"; return; }
      var xs = raw[0], t = xs[idx], tol = Math.max(d.step * 150, 1500);
      var r = nearest(raw, xs, 1, idx, tol); var i2 = r[1] != null ? s.x.indexOf(r[1]) : -1;
      var html = '<span class="t">' + esc(fmt(t)) + "</span>";
      if (i2 >= 0) {
        var tv = s.t[i2], hv = s.h[i2];
        html += '<span class="it">Temp <b>' + fmtVal("temp", tv) + '</b></span><span class="it">RH <b>' + fmtVal("hum", hv) + "</b></span>";
        if (tv != null && hv != null) html += '<span class="it">Dew <b>' + fmtVal("dew", dewF(tv, hv)) + '</b></span><span class="it">VPD <b>' + fmtVal("vpd", vpd(tv, hv)) + "</b></span>";
        if (r[1] !== t) html += '<span class="muted">(' + esc(fmt(r[1], "time")) + ")</span>";
      } else html += '<span class="muted">no reading near this time</span>';
      var ht = heatText(t); if (ht) html += '<span class="badge heat">' + esc(ht) + "</span>";
      el.innerHTML = html;
    }
  }
  function renderDetailTables() {
    var k = view(); if (k === "home") return;
    $("dDailyTbl").innerHTML = dailyRows(DATA.ddaily && DATA.ddaily[k]);
    $("dDropTbl").innerHTML = dropRows((S.summary ? S.summary.drops : []).filter(function (x) { return x.k === k; }));
  }

  function updateDownloads(w) {
    var raw = (w[1] - w[0]) <= 31 * 86400;
    $("dlCompare").title = raw ? "Every saved reading in this range" : "Averaged points for this long range";
  }
  function download(rooms, btn) {
    var w = windowFor(), old = btn.textContent; btn.textContent = "Preparing…";
    csvFor(rooms, w[0], w[1]).then(function (txt) {
      var url = URL.createObjectURL(new Blob([txt], { type: "text/csv" })), a = document.createElement("a");
      a.href = url; a.download = "sensors_" + etDate(w[0]).replace(/-/g, "") + "-" + etDate(w[1]).replace(/-/g, "") + ".csv";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }).catch(function (e) { alert("CSV failed: " + e.message); }).then(function () { btn.textContent = old; });
  }
  $("dlCompare").onclick = function (e) { e.preventDefault(); download(S.rooms.length ? S.rooms : ORDER, this); };
  $("dlDetail").onclick = function (e) { e.preventDefault(); if (view() !== "home") download([view()], this); };
  function labelGroups() {
    var u = UTIL.map(function (k) { return S.names[k]; }).filter(Boolean).join(" and ");
    if (u) { $("utilPreset").textContent = u; $("ioTitle").textContent = "Indoor vs " + u; }
  }

  // ---------- routing / live ----------
  function route() {
    var v = view();
    $("home").hidden = v !== "home"; $("detail").hidden = v === "home";
    destroyCharts(); renderControls();
    if (v !== "home") { renderDetailStats(); window.scrollTo(0, 0); }
    if (S.summary) reloadData().catch(function (e) { setLive(false, e); });
  }
  function setLive(ok, err) {
    var el = $("liveline");
    if (!ok) { el.innerHTML = '<span class="dot err"></span> <span class="err">Couldn\'t refresh (' + esc(err && err.message || "error") + "). Retrying.</span>"; return; }
    renderLive();
  }
  function renderLive() {
    if (!S.lastLoad) return;
    var left = Math.max(0, REFRESH_MS - (Date.now() - S.lastLoad)), mm = Math.floor(left / 60000), ss = Math.floor(left % 60000 / 1000);
    $("liveline").innerHTML = '<span class="dot"></span> Published ' + esc(fmt(S.summary.built, "short")) + " · checked " + esc(fmt(S.lastLoad / 1000, "time")) + " · next check " + mm + ":" + (ss < 10 ? "0" : "") + ss;
  }
  $("refreshBtn").onclick = function () { loadAll(); };
  $("backBtn").onclick = function () { if (history.length > 1 && /room=/.test(location.hash)) history.back(); else location.hash = ""; };
  $("dailyRoom").onchange = function () { S.dailyRoom = this.value; save("dailyRoom", S.dailyRoom); var w = windowFor(); dailyData([S.dailyRoom], w[0], w[1]).then(function (d) { DATA.daily = d; renderDaily(); }); };
  document.querySelectorAll("#presets button").forEach(function (b) { b.onclick = function () { var p = b.getAttribute("data-preset"); S.rooms = p === "live" ? LIVE.slice() : p === "indoor" ? INDOOR.slice() : p === "util" ? UTIL.slice() : ORDER.slice(); save("rooms", S.rooms); renderSummary(); reloadData(); }; });
  window.addEventListener("hashchange", route);
  setInterval(function () { if (!KEY) return; if (S.lastLoad && Date.now() - S.lastLoad >= REFRESH_MS && !document.hidden) loadAll(); renderLive(); }, 1000);
  document.addEventListener("visibilitychange", function () { if (KEY && !document.hidden && Date.now() - S.lastLoad >= REFRESH_MS) loadAll(); });
  function start() {
    $("login").hidden = true; $("shell").hidden = false;
    renderControls();
    $("home").hidden = view() !== "home"; $("detail").hidden = view() === "home";
    loadAll();
  }
  function lock() { try { sessionStorage.removeItem(SKEY); } catch (e) {} KEY = null; MAN = null; BLOBS = {}; DECODED = {}; location.replace(location.pathname); }
  $("lockBtn").onclick = lock;
  var msg = $("loginMsg");
  if (!window.crypto || !crypto.subtle || typeof DecompressionStream === "undefined") { msg.textContent = "This browser is too old to open the dashboard."; msg.className = "cap err"; }
  $("loginForm").onsubmit = function (e) {
    e.preventDefault(); var pw = $("pw").value; if (!pw) return;
    $("unlockBtn").disabled = true; msg.className = "cap"; msg.textContent = "Unlocking…";
    var raw;
    kjson().then(function (k) { return deriveKey(pw, k); }).then(function (bits) { raw = bits; return importRaw(bits); }).then(function (key) { KEY = key; return loadManifest(); })
      .then(function () { try { sessionStorage.setItem(SKEY, b64(raw)); } catch (e2) {} $("pw").value = ""; start(); })
      .catch(function () { KEY = null; msg.className = "cap err"; msg.textContent = "Wrong password (or the data couldn't be loaded)."; $("unlockBtn").disabled = false; $("pw").select(); });
  };
  var saved = null; try { saved = sessionStorage.getItem(SKEY); } catch (e) {}
  if (saved) {
    importRaw(unb64(saved)).then(function (key) { KEY = key; return loadManifest(); }).then(start).catch(function () { try { sessionStorage.removeItem(SKEY); } catch (e) {} $("login").hidden = false; });
  }
})();
