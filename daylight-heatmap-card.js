/* Daylight Heatmap Card for Home Assistant — v0.2.1
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
      return { title: "Luce disponibile", mode: "sunrise_sunset", view: "year", days: 7, show_hours: true, show_delta: true };
    }

    getCardSize() {
      return 6;
    }

    setConfig(config) {
      if (!config) throw new Error("Config mancante");
      this.config = Object.assign(
        { mode: "sunrise_sunset", view: "year", days: 7, show_hours: true, show_delta: true, lang: "it" },
        config
      );
      if (!ZENITH[this.config.mode]) this.config.mode = "sunrise_sunset";
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
      const showDelta = this.config.show_delta !== false;
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
        return `<div class="wcell${isToday ? " today" : ""}${isFuture ? " future" : ""}" style="background:${colorFor(mins, smin, smax)};color:${textColor(mins, smin, smax)}" title="${wdays[dt.getDay()]} ${dt.getDate()} ${months[dt.getMonth()]}: ${fmtHM(mins)} (${modeLabel})">
          <div class="wd">${wdays[dt.getDay()]}${isToday ? " •" : ""}</div>
          <div class="dt">${dt.getDate()}/${dt.getMonth() + 1}</div>
          <div class="hm">${fmtHM(mins)}</div>${deltaTxt}</div>`;
      }).join("");

      const style = `<style>
        .strip { display:grid; grid-template-columns:repeat(${n},1fr); gap:4px; }
        .wcell { text-align:center; border-radius:8px; padding:8px 2px 6px; line-height:1.3; }
        .wcell.today { outline:2px solid var(--primary-color,#03a9f4); outline-offset:-2px; }
        .wcell.future { outline:1px dashed currentColor; outline-offset:-3px; }
        .wd { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; opacity:.85; }
        .dt { font-size:10px; opacity:.7; }
        .hm { font-size:16px; font-weight:700; font-variant-numeric:tabular-nums; margin-top:2px; }
        .delta { font-size:10px; opacity:.85; font-variant-numeric:tabular-nums; }
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
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "daylight-heatmap-card",
    name: "Daylight Heatmap Card",
    description: "Tabella annuale o striscia settimanale della luce disponibile (ore:minuti).",
    preview: true,
  });
})();
