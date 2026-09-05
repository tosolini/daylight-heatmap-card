/* Daylight Heatmap Card for Home Assistant — v0.3.0
 * Luce disponibile giorno per giorno (ore:minuti), calcolo astronomico da
 * latitudine + giorno. Offline, passato e futuro, nessuna API esterna.
 *
 * Durata = 2*H/15 dove cosH = (cos(Z) - sinφ·sinδ) / (cosφ·cosδ)
 *   δ (Cooper) = -23.44° · cos(2π·(N+10)/365), N = giorno dell'anno
 *   Z = 90.833° (alba/tramonto) | 96° civil | 102° nautical | 108° astronomical
 * Accuratezza ~1-2 min. Giorno polare → 24:00, notte → 0:00.
 *
 * Viste: year (tabella 12x31) | week (striscia N giorni come temperature-heatmap-card).
 * La vista week mostra di default gli ultimi N giorni fino a oggi; ‹ › spostano
 * la finestra di N giorni avanti/indietro — anche nel futuro (deterministico).
 */
(function () {
  const ZENITH = {
    sunrise_sunset: 90.833,
    civil: 96.0,
    nautical: 102.0,
    astronomical: 108.0,
  };

  const MONTH_SHORT = {
    it: ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"],
    en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  };

  const WEEKDAY_SHORT = {
    it: ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"],
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  };

  function declinationDeg(dayOfYear) {
    return -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));
  }

  function daylightMinutes(latDeg, dayOfYear, zenithDeg) {
    const lat = (latDeg * Math.PI) / 180;
    const dec = (declinationDeg(dayOfYear) * Math.PI) / 180;
    const cosZ = Math.cos((zenithDeg * Math.PI) / 180);
    const cosH = (cosZ - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
    if (cosH <= -1) return 1440;
    if (cosH >= 1) return 0;
    const H = (Math.acos(cosH) * 180) / Math.PI;
    return Math.round(((2 * H) / 15) * 60);
  }

  function fmtHM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + ":" + String(m).padStart(2, "0");
  }

  function dayOfYear(y, m0, d) {
    return Math.round((Date.UTC(y, m0, d) - Date.UTC(y, 0, 0)) / 86400000);
  }

  function dayOfYearFromDate(dt) {
    return dayOfYear(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }
  // Ora del tramonto in minuti da 00:00 UTC (algoritmo NOAA, zenit 90.833°).
  // null = sole che non tramonta/sorge (giorno/notte polare).
  function sunsetUTCMinutes(latDeg, lngDeg, date) {
    const rad = Math.PI / 180;
    const N = dayOfYearFromDate(date);
    const lngHour = lngDeg / 15;
    const t = N + (18 - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360;
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
    RA = ((RA % 360) + 360) % 360;
    RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
    RA /= 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(latDeg * rad)) / (cosDec * Math.cos(latDeg * rad));
    if (cosH > 1 || cosH < -1) return null;
    const H = Math.acos(cosH) / rad / 15;
    const T = H + RA - 0.06571 * t - 6.622;
    return (((T - lngHour) % 24 + 24) % 24) * 60;
  }

  // "21:13" nel fuso di HA (DST automatico via Intl). "—" se non tramonta.
  function fmtSunset(latDeg, lngDeg, date, timeZone, locale) {
    const mins = sunsetUTCMinutes(latDeg, lngDeg, date);
    if (mins === null) return "—";
    const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + Math.round(mins) * 60000);
    try {
      return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "it-IT", { hour: "2-digit", minute: "2-digit", timeZone }).format(utc);
    } catch (e) {
      return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "it-IT", { hour: "2-digit", minute: "2-digit" }).format(utc);
    }
  }

  function isLeap(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  function addDays(dt, n) {
    const c = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    c.setDate(c.getDate() + n);
    return c;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function lerp(a, b, t) {
    return Math.round(a + (b - a) * t);
  }

  function colorFor(mins, min, max) {
    const t = max <= min ? 0.5 : Math.min(1, Math.max(0, (mins - min) / (max - min)));
    const c0 = [59, 91, 191];
    const c1 = [255, 201, 60];
    return `rgb(${lerp(c0[0], c1[0], t)},${lerp(c0[1], c1[1], t)},${lerp(c0[2], c1[2], t)})`;
  }

  function textColor(mins, min, max) {
    const t = max <= min ? 0.5 : (mins - min) / (max - min);
    return t > 0.55 ? "#3a2c00" : "#ffffff";
  }

  // Min/max sull'anno di riferimento: scala colori stabile tra le viste e durante la navigazione.
  function yearMinMax(lat, year, zenith) {
    let mn = 1440;
    let mx = 0;
    const leap = isLeap(year);
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let m = 0; m < 12; m++) {
      for (let d = 1; d <= dim[m]; d++) {
        const v = daylightMinutes(lat, dayOfYear(year, m, d), zenith);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    return [mn, mx];
  }

  const MODE_LABEL = {
    sunrise_sunset: { it: "alba→tramonto", en: "sunrise→sunset" },
    civil: { it: "crepuscolo civile", en: "civil twilight" },
    nautical: { it: "crepuscolo nautico", en: "nautical twilight" },
    astronomical: { it: "crepuscolo astronomico", en: "astronomical twilight" },
  };

  class DaylightHeatmapCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._offset = 0; // year: anni | week: finestre da `days` giorni
      this._viewOverride = null; // toggle live Anno/Settimana senza toccare YAML
    }

    static getStubConfig() {
      return { title: "Luce disponibile", mode: "sunrise_sunset", view: "year", days: 7, show_hours: true, show_delta: true, show_sunset: true };
    }

    setConfig(config) {
      if (!config) throw new Error("Config mancante");
      this.config = Object.assign(
        { mode: "sunrise_sunset", view: "year", days: 7, show_hours: true, show_delta: true, show_sunset: true, lang: "it" },
        config
      );
      if (this.config.view !== "week" && this.config.view !== "year") this.config.view = "year";
      this.config.days = Math.min(14, Math.max(3, Number(this.config.days) || 7));
      this._offset = 0;
      this._viewOverride = null;
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._render();
    }

    _view() {
      return this._viewOverride || this.config.view;
    }

    _latitude() {
      if (this.config.latitude !== undefined && this.config.latitude !== null && this.config.latitude !== "") {
        const v = Number(this.config.latitude);
        if (Number.isFinite(v) && v >= -90 && v <= 90) return v;
      }
      const lat = this._hass && this._hass.config && this._hass.config.latitude;
      return Number.isFinite(lat) ? lat : 45.46;
    }

    _longitude() {
      if (this.config.longitude !== undefined && this.config.longitude !== null && this.config.longitude !== "") {
        const v = Number(this.config.longitude);
        if (Number.isFinite(v) && v >= -180 && v <= 180) return v;
      }
      const lng = this._hass && this._hass.config && this._hass.config.longitude;
      return Number.isFinite(lng) ? lng : 9.19; // fallback Milano
    }

    _timeZone() {
      const tz = this._hass && this._hass.config && this._hass.config.time_zone;
      if (typeof tz === "string" && tz) return tz;
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (e) {
        return undefined;
      }
    }
    _render() {
      if (!this.shadowRoot || !this.config) return;
      if (this._view() === "week") this._renderWeek();
      else this._renderYear();
    }

    _chrome({ title, sub, body, foot }) {
      const view = this._view();
      this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px 12px 8px; }
        .head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:6px; }
        .title { font-size:15px; font-weight:600; }
        .sub { font-size:11px; opacity:.65; margin-top:2px; }
        .views { display:flex; gap:4px; margin-top:6px; }
        .views button { border:1px solid var(--divider-color,#e0e0e0); background:transparent;
          color:var(--primary-text-color,inherit); border-radius:8px; padding:1px 10px; cursor:pointer; font-size:11px; opacity:.7; }
        .views button.on { opacity:1; font-weight:700; background:var(--secondary-background-color,#f0f0f0); }
        .nav { display:flex; gap:4px; align-items:center; }
        .nav button { border:1px solid var(--divider-color,#e0e0e0); background:var(--card-background-color,transparent);
          color:var(--primary-text-color,inherit); border-radius:8px; padding:2px 10px; cursor:pointer; font-size:13px; }
        .nav button:hover { background:var(--secondary-background-color,#f0f0f0); }
        .foot { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:8px; font-size:11px; opacity:.85; }
        .foot b { font-variant-numeric:tabular-nums; }
      </style>
      <ha-card>
        <div class="head">
          <div>
            <div class="title">${title}</div>
            <div class="sub">${sub}</div>
            <div class="views">
              <button id="vYear" class="${view === "year" ? "on" : ""}">Anno</button>
              <button id="vWeek" class="${view === "week" ? "on" : ""}">Settimana</button>
            </div>
          </div>
          <div class="nav">
            <button id="prev" title="Indietro">‹</button>
            <button id="now" title="Torna a oggi">•</button>
            <button id="next" title="Avanti">›</button>
          </div>
        </div>
        ${body}
        <div class="foot">${foot}</div>
      </ha-card>`;
      this.shadowRoot.getElementById("prev").onclick = (e) => { e.stopPropagation(); this._offset--; this._render(); };
      this.shadowRoot.getElementById("next").onclick = (e) => { e.stopPropagation(); this._offset++; this._render(); };
      this.shadowRoot.getElementById("now").onclick = (e) => { e.stopPropagation(); this._offset = 0; this._render(); };
      this.shadowRoot.getElementById("vYear").onclick = (e) => { e.stopPropagation(); this._viewOverride = "year"; this._offset = 0; this._render(); };
      this.shadowRoot.getElementById("vWeek").onclick = (e) => { e.stopPropagation(); this._viewOverride = "week"; this._offset = 0; this._render(); };
    }

    _renderYear() {
      const lat = this._latitude();
      const baseYear = Number.isInteger(this.config.year) ? this.config.year : new Date().getFullYear();
      const year = baseYear + this._offset;
      const zenith = ZENITH[this.config.mode];
      const lang = this.config.lang === "en" ? "en" : "it";
      const months = MONTH_SHORT[lang];
      const showHours = this.config.show_hours !== false;
      const showDelta = this.config.show_delta !== false;
      const leap = isLeap(year);
      const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

      let gmin = 1440;
      let gmax = 0;
      const grid = [];
      for (let m = 0; m < 12; m++) {
        grid[m] = [];
        for (let d = 1; d <= dim[m]; d++) {
          const mins = daylightMinutes(lat, dayOfYear(year, m, d), zenith);
          grid[m][d] = mins;
          if (mins < gmin) gmin = mins;
          if (mins > gmax) gmax = mins;
        }
      }
      const gsum = grid.flatMap((mm, m) => Array.from({ length: dim[m] }, (_, i) => mm[i + 1])).reduce((a, b) => a + b, 0);
      const gmean = Math.round(gsum / dim.reduce((a, b) => a + b, 0));

      const now = new Date();
      const isThisYear = now.getFullYear() === year;
      const modeLabel = (MODE_LABEL[this.config.mode] || MODE_LABEL.sunrise_sunset)[lang];

      let rows = "";
      for (let d = 1; d <= 31; d++) {
        let tds = `<td class="daynum">${d}</td>`;
        for (let m = 0; m < 12; m++) {
          if (d > dim[m]) { tds += `<td class="empty"></td>`; continue; }
          const mins = grid[m][d];
          const isToday = isThisYear && m === now.getMonth() && d === now.getDate();
          let deltaTxt = "";
          if (showDelta) {
            let pm = m, pd = d - 1;
            if (pd < 1) { pm = m - 1; if (pm >= 0) pd = dim[pm]; }
            if (pm >= 0 && pd >= 1 && grid[pm][pd] !== undefined) {
              const dd = mins - grid[pm][pd];
              if (dd !== 0) deltaTxt = `<span class="delta ${dd > 0 ? "up" : "down"}">${dd > 0 ? "+" : "−"}${Math.abs(dd)}′</span>`;
            }
          }
          tds += `<td class="cell${isToday ? " today" : ""}" style="background:${colorFor(mins, gmin, gmax)};color:${textColor(mins, gmin, gmax)}" title="${d} ${months[m]} ${year}: ${fmtHM(mins)} (${modeLabel})"><div class="hm">${showHours ? fmtHM(mins) : ""}</div>${deltaTxt}</td>`;
        }
        rows += `<tr>${tds}</tr>`;
      }

      const style = `<style>
        .wrap { overflow-x:auto; }
        table { border-collapse:separate; border-spacing:2px; width:100%; font-size:10px; }
        th { font-size:10px; font-weight:600; opacity:.75; padding:2px 1px; min-width:44px; }
        td.daynum { text-align:right; opacity:.55; padding-right:4px; min-width:18px; font-size:10px; }
        td.cell { text-align:center; border-radius:5px; padding:3px 1px; min-width:44px; line-height:1.25; }
        td.cell.today { outline:2px solid var(--primary-color,#03a9f4); outline-offset:-2px; font-weight:700; }
        td.empty { background:transparent; }
        .hm { font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; }
        .delta { font-size:8px; opacity:.8; font-variant-numeric:tabular-nums; white-space:nowrap; }
        .delta.up::before { content:"▲ "; font-size:7px; }
        .delta.down::before { content:"▼ "; font-size:7px; }
        @media (max-width:640px){ th, td.cell { min-width:34px; } table { font-size:9px; } }
      </style>`;

      this._chrome({
        title: this.config.title || "Luce disponibile",
        sub: `${year} · ${modeLabel} · lat ${lat.toFixed(2)}°`,
        body: `${style}<div class="wrap"><table><tr><th></th>${months.map((mm) => `<th>${mm}</th>`).join("")}</tr>${rows}</table></div>`,
        foot: `<span>Min <b>${fmtHM(gmin)}</b></span><span>Max <b>${fmtHM(gmax)}</b></span><span>Media <b>${fmtHM(gmean)}</b></span><span>Escursione <b>${fmtHM(gmax - gmin)}</b></span>`,
      });
      const prev = this.shadowRoot.getElementById("prev"); if (prev) prev.title = "Anno precedente";
      const next = this.shadowRoot.getElementById("next"); if (next) next.title = "Anno successivo";
    }

    _renderWeek() {
      const lat = this._latitude();
      const zenith = ZENITH[this.config.mode];
      const lang = this.config.lang === "en" ? "en" : "it";
      const months = MONTH_SHORT[lang];
      const wdays = WEEKDAY_SHORT[lang];
      const n = this.config.days;
      const showSunset = this.config.show_sunset !== false;
      const showDelta = this.config.show_delta !== false;
      const lng = this._longitude();
      const tz = this._timeZone();
      const modeLabel = (MODE_LABEL[this.config.mode] || MODE_LABEL.sunrise_sunset)[lang];
      const today = new Date();

      // Finestra di N giorni che termina oggi, spostata di offset*N (anche nel futuro).
      const end = addDays(today, this._offset * n);
      const days = Array.from({ length: n }, (_, i) => addDays(end, i - (n - 1)));

      const vals = days.map((dt) => daylightMinutes(lat, dayOfYearFromDate(dt), zenith));
      const [smin, smax] = yearMinMax(lat, days[n - 1].getFullYear(), zenith);
      const wmin = Math.min(...vals);
      const wmax = Math.max(...vals);
      const wmean = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);

      const rangeLbl = `${days[0].getDate()} ${months[days[0].getMonth()]} → ${days[n - 1].getDate()} ${months[days[n - 1].getMonth()]} ${days[n - 1].getFullYear()}`;

      const cells = days.map((dt, i) => {
        const mins = vals[i];
        const isToday = sameDay(dt, today);
        const isFuture = dt > today && !isToday;
        let dd = 0;
        if (i > 0) dd = vals[i] - vals[i - 1];
        else dd = mins - daylightMinutes(lat, dayOfYearFromDate(addDays(dt, -1)), zenith);
        const deltaTxt = showDelta && dd !== 0 ? `<div class="delta ${dd > 0 ? "up" : "down"}">${dd > 0 ? "+" : "−"}${Math.abs(dd)}′</div>` : `<div class="delta">·</div>`;
        const sunset = showSunset ? fmtSunset(lat, lng, dt, tz, lang) : null;
        const sunsetLbl = lang === "en" ? "Sunset" : "Tramonto";
        return `<div class="wcell${isToday ? " today" : ""}${isFuture ? " future" : ""}" style="background:${colorFor(mins, smin, smax)};color:${textColor(mins, smin, smax)}" title="${wdays[dt.getDay()]} ${dt.getDate()} ${months[dt.getMonth()]}: ${fmtHM(mins)} (${modeLabel})${sunset ? `, ${sunsetLbl.toLowerCase()} ${sunset}` : ""}">
          <div class="wd">${wdays[dt.getDay()]}${isToday ? " •" : ""}</div>
          <div class="dt">${dt.getDate()}/${dt.getMonth() + 1}</div>
          ${sunset ? `<div class="sunset" title="${sunsetLbl}">↓ ${sunset}</div>` : ""}
          <div class="hm">${fmtHM(mins)}</div>${deltaTxt}</div>`;
      }).join("");

      const style = `<style>
        .strip { display:grid; grid-template-columns:repeat(${n},minmax(0,1fr)); gap:4px; }
        .wcell { min-width:0; overflow:hidden; text-align:center; border-radius:8px; padding:8px 1px 6px; line-height:1.3; }
        .wcell.today { outline:2px solid var(--primary-color,#03a9f4); outline-offset:-2px; }
        .wcell.future { outline:1px dashed currentColor; outline-offset:-3px; }
        .wd { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; opacity:.85; }
        .dt { font-size:10px; opacity:.7; }
        .hm { font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; margin-top:3px; }
        .sunset { margin-top:5px; font-size:12px; font-weight:500; opacity:.8; font-variant-numeric:tabular-nums; white-space:nowrap; }
        .delta { font-size:10px; opacity:.85; font-variant-numeric:tabular-nums; }
        @media (max-width:640px){ .hm { font-size:15px; } .sunset { font-size:11px; } }
        .delta.up::before { content:"▲ "; font-size:8px; }
        .delta.down::before { content:"▼ "; font-size:8px; }
      </style>`;

      this._chrome({
        title: this.config.title || "Luce disponibile",
        sub: `${rangeLbl} · ${modeLabel} · lat ${lat.toFixed(2)}°`,
        body: `${style}<div class="strip">${cells}</div>`,
        foot: `<span>Periodo min <b>${fmtHM(wmin)}</b></span><span>max <b>${fmtHM(wmax)}</b></span><span>media <b>${fmtHM(wmean)}</b></span>`,
      });
      const prev = this.shadowRoot.getElementById("prev"); if (prev) prev.title = `Indietro di ${n} giorni`;
      const next = this.shadowRoot.getElementById("next"); if (next) next.title = `Avanti di ${n} giorni`;
    }
  }

  if (!customElements.get("daylight-heatmap-card")) {
    customElements.define("daylight-heatmap-card", DaylightHeatmapCard);
  }
  /* Editor visuale: form nativo HA, niente YAML. HA chiama setConfig() e
   * ascolta l'evento "config-changed" con la config aggiornata. */
  class DaylightHeatmapCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._built = false;
    }

    setConfig(config) {
      this._config = Object.assign({}, config);
      if (this._built) this._sync();
      else this._build();
    }

    set hass(hass) {
      this._hass = hass;
    }

    _t(key) {
      const lang = (this._config && this._config.lang) === "en" ? "en" : "it";
      const STR = {
        title: { it: "Titolo", en: "Title" },
        view: { it: "Vista iniziale", en: "Initial view" },
        year: { it: "Anno (tabella 12 mesi)", en: "Year (12-month table)" },
        week: { it: "Settimana (striscia giorni)", en: "Week (day strip)" },
        days: { it: "Giorni per pagina (vista settimana)", en: "Days per page (week view)" },
        mode: { it: "Riferimento luce", en: "Light reference" },
        sunrise_sunset: { it: "Alba → tramonto", en: "Sunrise → sunset" },
        civil: { it: "Crepuscolo civile (luce utile)", en: "Civil twilight (useful light)" },
        nautical: { it: "Crepuscolo nautico", en: "Nautical twilight" },
        astronomical: { it: "Crepuscolo astronomico", en: "Astronomical twilight" },
        lang: { it: "Lingua", en: "Language" },
        latitude: { it: "Latitudine (vuoto = quella di HA)", en: "Latitude (empty = HA one)" },
        longitude: { it: "Longitudine (vuoto = quella di HA)", en: "Longitude (empty = HA one)" },
        yearFix: { it: "Anno fisso (vuoto = corrente)", en: "Fixed year (empty = current)" },
        show_hours: { it: "Mostra ore:minuti", en: "Show hours:minutes" },
        show_delta: { it: "Mostra variazione giornaliera", en: "Show daily change" },
        show_sunset: { it: "Mostra ora del tramonto (vista settimana)", en: "Show sunset time (week view)" },
      };
      return (STR[key] || {})[lang] || key;
    }

    _build() {
      const c = this._config;
      this.shadowRoot.innerHTML = `
      <style>
        .form { display:grid; gap:12px; padding:4px 0; color:var(--primary-text-color,inherit); }
        .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        label.f { display:grid; gap:4px; font-size:12px; opacity:.9; }
        label.f > span { opacity:.75; }
        input, select { width:100%; box-sizing:border-box; padding:8px; border-radius:6px;
          border:1px solid var(--divider-color,#e0e0e0);
          background:var(--secondary-background-color,transparent);
          color:var(--primary-text-color,inherit); font-size:14px; }
        .switch { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:14px; }
        .switch input { width:auto; width:18px; height:18px; accent-color:var(--primary-color,#03a9f4); }
      </style>
      <div class="form">
        <label class="f"><span>${this._t("title")}</span><input id="fTitle" type="text" value="${c.title || ""}"></label>
        <div class="row2">
          <label class="f"><span>${this._t("view")}</span><select id="fView">
            <option value="year">${this._t("year")}</option>
            <option value="week">${this._t("week")}</option>
          </select></label>
          <label class="f"><span>${this._t("lang")}</span><select id="fLang">
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select></label>
        </div>
        <div class="row2">
          <label class="f"><span>${this._t("days")}</span><input id="fDays" type="number" min="3" max="14" step="1"></label>
          <label class="f"><span>${this._t("mode")}</span><select id="fMode">
            <option value="sunrise_sunset">${this._t("sunrise_sunset")}</option>
            <option value="civil">${this._t("civil")}</option>
            <option value="nautical">${this._t("nautical")}</option>
            <option value="astronomical">${this._t("astronomical")}</option>
          </select></label>
        </div>
        <div class="row2">
          <label class="f"><span>${this._t("latitude")}</span><input id="fLat" type="number" step="0.01" min="-90" max="90"></label>
          <label class="f"><span>${this._t("longitude")}</span><input id="fLng" type="number" step="0.01" min="-180" max="180"></label>
        </div>
        <label class="f"><span>${this._t("yearFix")}</span><input id="fYear" type="number" step="1"></label>
        <div class="switch"><span>${this._t("show_hours")}</span><input id="fHours" type="checkbox"></div>
        <div class="switch"><span>${this._t("show_delta")}</span><input id="fDelta" type="checkbox"></div>
        <div class="switch"><span>${this._t("show_sunset")}</span><input id="fSun" type="checkbox"></div>
      </div>`;
      const $ = (id) => this.shadowRoot.getElementById(id);
      // Valori iniziali via _sync (stessa logica del re-sync, non ruba il focus).
      this._built = true;
      this._sync();
      $("fTitle").addEventListener("input", (e) => this._fire({ title: e.target.value }));
      $("fView").addEventListener("change", (e) => this._fire({ view: e.target.value }));
      $("fLang").addEventListener("change", (e) => this._fire({ lang: e.target.value }));
      $("fMode").addEventListener("change", (e) => this._fire({ mode: e.target.value }));
      $("fDays").addEventListener("input", (e) => {
        const v = Math.min(14, Math.max(3, parseInt(e.target.value, 10) || 7));
        this._fire({ days: v });
      });
      $("fLat").addEventListener("input", (e) => {
        const patch = {};
        if (e.target.value === "" || e.target.value === null) patch.latitude = undefined;
        else { const v = Number(e.target.value); if (Number.isFinite(v)) patch.latitude = Math.min(90, Math.max(-90, v)); }
        this._fire(patch, ["latitude"]);
      });
      $("fLng").addEventListener("input", (e) => {
        const patch = {};
        if (e.target.value === "" || e.target.value === null) patch.longitude = undefined;
        else { const v = Number(e.target.value); if (Number.isFinite(v)) patch.longitude = Math.min(180, Math.max(-180, v)); }
        this._fire(patch, ["longitude"]);
      });
      $("fYear").addEventListener("input", (e) => {
        const patch = {};
        if (e.target.value === "" || e.target.value === null) patch.year = undefined;
        else { const v = parseInt(e.target.value, 10); if (Number.isInteger(v)) patch.year = v; }
        this._fire(patch, ["year"]);
      });
      $("fHours").addEventListener("change", (e) => this._fire({ show_hours: e.target.checked }));
      $("fDelta").addEventListener("change", (e) => this._fire({ show_delta: e.target.checked }));
      $("fSun").addEventListener("change", (e) => this._fire({ show_sunset: e.target.checked }));
    }

    _sync() {
      // Aggiorna i valori senza ricostruire (non ruba il focus mentre si digita).
      const c = this._config;
      const $ = (id) => this.shadowRoot.getElementById(id);
      const set = (id, prop, val) => { const el = $(id); if (el && document.activeElement !== el) el[prop] = val; };
      set("fTitle", "value", c.title || "");
      set("fView", "value", c.view === "week" ? "week" : "year");
      set("fLang", "value", c.lang === "en" ? "en" : "it");
      set("fDays", "value", c.days || 7);
      set("fMode", "value", c.mode || "sunrise_sunset");
      set("fLat", "value", c.latitude ?? "");
      set("fYear", "value", Number.isInteger(c.year) ? c.year : "");
      set("fLng", "value", c.longitude ?? "");
      set("fHours", "checked", c.show_hours !== false);
      set("fDelta", "checked", c.show_delta !== false);
      set("fSun", "checked", c.show_sunset !== false);
    }

    _fire(patch, dropIfUndefined) {
      const next = Object.assign({}, this._config, patch);
      (dropIfUndefined || []).forEach((k) => { if (next[k] === undefined) delete next[k]; });
      this._config = next;
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true }));
    }
  }

  if (!customElements.get("daylight-heatmap-card-editor")) {
    customElements.define("daylight-heatmap-card-editor", DaylightHeatmapCardEditor);
  }
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "daylight-heatmap-card",
    name: "Daylight Heatmap Card",
    description: "Tabella annuale o striscia settimanale della luce disponibile (ore:minuti).",
    preview: true,
  });
})();
