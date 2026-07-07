// View renderers. Each render* function returns the populated DOM node
// for a `<template>` defined in /index.html. The router clones the
// template, calls the renderer to wire up listeners, and mounts it.

import { LOCKED_SECTION_KEYS, SECTION_TITLES } from "./sections.js";
import * as api from "./api.js";

// Set in /loading right before the /result navigation, consumed by /result on
// mount. Distinguishes "user just completed the form journey" (autoplay the
// free section's audio for the hook effect) from "user landed on this URL via
// share / refresh / back button" (don't autoplay — they didn't earn the
// ritual moment and would be ambushed by sudden audio).
const JOURNEY_FLAG = "yildizname:from-journey";

const MONTHS_TR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];

// Phased loading text. Time-gated by elapsed seconds; within each phase the
// 3 primary/secondary lines cycle every ~4.5s for variety. Designed so the
// last phase ("Yıldızname dürülüyor…") feels like an arrival — and if the
// LLM call runs over 2:30, that last phase keeps cycling gracefully.
const LOADING_PHASES = [
  {
    startSec: 0,
    primary: [
      "Müneccim divânını açıyor…",
      "Eskimiş cilt aralanıyor…",
      "Yıldız sayfası açılıyor…",
    ],
    secondary: [
      "Bir kapı kapanır, bir kapı açılır.",
      "Sayfanın kokusu kadim.",
      "Mâzi, hâle bakar.",
    ],
  },
  {
    startSec: 22,
    primary: [
      "Harfler ebced cetveline düşüyor…",
      "Adın sayılara dönüşüyor…",
      "Anne adı altın iplikle iliştiriliyor…",
    ],
    secondary: [
      "Elif 1, bâ 2, cîm 3, dâl 4…",
      "Her harf bir kapı, her sayı bir kilit.",
      "Ne yazılıysa orada toplanır.",
    ],
  },
  {
    startSec: 45,
    primary: [
      "Ay yirmi sekiz menzilinden geçiyor…",
      "Burç hizalanıyor…",
      "Doğum vakti yerine oturuyor…",
    ],
    secondary: [
      "Şereteyn, Butayn, Süreyya, Deberân…",
      "Felek dönüyor, çark işliyor.",
      "Vakit ne dediyse o yazılır.",
    ],
  },
  {
    startSec: 68,
    primary: [
      "Yedi yıldız hizalanıyor…",
      "Gezegenler raptediliyor…",
      "Gökyüzü hesabı tamamlanıyor…",
    ],
    secondary: [
      "Şems, Kamer, Mirrîh, Utârid, Müşterî, Zühre, Zühal.",
      "Her birinin ayrı hükmü var.",
      "Sayılar mührünü vuruyor.",
    ],
  },
  {
    startSec: 90,
    primary: [
      "Hükümler kantarda tartılıyor…",
      "Hayır ve şer aynı sayfada…",
      "Müneccim kalemini sürtüyor…",
    ],
    secondary: [
      "Doğru söz, eğri söz olmaz.",
      "Ne ışık tek başına, ne gölge.",
      "Adâlet terazide.",
    ],
  },
  {
    startSec: 112,
    primary: [
      "Yıldızname dürülüyor…",
      "Mühür düşmek üzere…",
      "Son satır mürekkep alıyor…",
    ],
    secondary: [
      "Bir an sonra önündedir.",
      "Ne yazıldıysa kalıcıdır.",
      "Sabret biraz daha.",
    ],
  },
];

// 5 hand-laid constellations rendered into a 200×120 viewBox. The names use
// Ottoman/medieval-Islamic naming tradition where it fits cleanly.
const CONSTELLATIONS = [
  {
    name: "Süreyya",
    points: [[80, 50], [95, 45], [110, 50], [120, 55], [85, 65], [105, 65]],
    lines: [[0, 1], [1, 2], [2, 3], [1, 4], [2, 5]],
  },
  {
    name: "Cevza",
    points: [[80, 40], [120, 40], [100, 60], [85, 60], [115, 60], [80, 85], [120, 85]],
    lines: [[0, 1], [0, 3], [1, 4], [3, 4], [3, 5], [4, 6]],
  },
  {
    name: "Yedi Kardeşler",
    points: [[60, 70], [75, 65], [90, 60], [105, 60], [115, 75], [105, 90], [75, 90]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]],
  },
  {
    name: "Akrep",
    points: [[70, 50], [85, 55], [100, 60], [115, 65], [115, 80], [125, 90], [135, 85]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
  },
  {
    name: "Tâcüssema",
    points: [[70, 65], [80, 55], [95, 50], [110, 50], [125, 55], [135, 65]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
  },
];

// The 28-letter abjad set. One is plucked at random every few seconds for
// the ambient harfler — adds the "ilm-i hurûf" texture without taking
// focus from the moon or the constellations.
const HARFLER = [
  "ا", "ب", "ج", "د", "ه", "و", "ز", "ح", "ط", "ي",
  "ك", "ل", "م", "ن", "س", "ع", "ف", "ص", "ق", "ر",
  "ش", "ت", "ث", "خ", "ذ", "ض", "ظ", "غ",
];

const FORM_SESSION_KEY = "yildizname:form";

function tpl(id) {
  const t = document.getElementById(id);
  if (!t) throw new Error(`Missing template: ${id}`);
  return t.content.firstElementChild.cloneNode(true);
}

// ----------------------------------------------------------------------------
// Landing
// ----------------------------------------------------------------------------

export function renderLanding(router) {
  const root = tpl("tpl-landing");
  const cta = root.querySelector(".cta-start-journey");
  if (cta) {
    cta.addEventListener("click", () => router.setStep("form"));
  }
  return root;
}

// ----------------------------------------------------------------------------
// Form
// ----------------------------------------------------------------------------

const TOTAL_STEPS = 6;

function isValidStep(step, data) {
  switch (step) {
    case 0:
      return data.name.trim().length > 1;
    case 1:
      return data.motherName.trim().length > 0;
    case 2:
      return Boolean(data.bDay && data.bMonth && data.bYear);
    case 3:
      return data.birthPlace.trim().length > 0;
    case 4:
    case 5:
      return true;
    default:
      return false;
  }
}

function composeBirthDate(data) {
  if (!data.bDay || !data.bMonth || !data.bYear) return "";
  return `${data.bYear}-${String(data.bMonth).padStart(2, "0")}-${String(data.bDay).padStart(2, "0")}`;
}

function buildStepNode(step, data, onInput) {
  const wrap = document.createElement("div");
  wrap.className = "step";
  wrap.dataset.step = String(step);

  const heading = document.createElement("h2");
  const hint = document.createElement("p");
  hint.className = "hint";
  wrap.append(heading, hint);

  const mountField = (el) => wrap.appendChild(el);

  switch (step) {
    case 0: {
      heading.textContent = "Adın ve soyadın nedir?";
      hint.textContent = "Tam adın, anneden geldiği şekliyle.";
      const i = document.createElement("input");
      i.className = "field-input";
      i.placeholder = "Yusuf Kara";
      i.value = data.name;
      i.autofocus = true;
      i.addEventListener("input", () => onInput({ name: i.value }));
      mountField(i);
      break;
    }
    case 1: {
      heading.textContent = "Annenin adı?";
      hint.textContent = "Yıldızname annenin adını ister; isim oradan iner.";
      const i = document.createElement("input");
      i.className = "field-input";
      i.placeholder = "Fatma";
      i.value = data.motherName;
      i.autofocus = true;
      i.addEventListener("input", () => onInput({ motherName: i.value }));
      mountField(i);
      break;
    }
    case 2: {
      heading.textContent = "Doğum tarihin?";
      hint.textContent = "Gün, ay, yıl — bildiğin kadarıyla.";
      const row = document.createElement("div");
      row.className = "date-row";

      const day = document.createElement("select");
      day.className = "field-select";
      day.innerHTML = `<option value="">Gün</option>` +
        Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
      day.value = data.bDay || "";
      day.addEventListener("change", () => onInput({ bDay: day.value }));

      const month = document.createElement("select");
      month.className = "field-select";
      month.innerHTML = `<option value="">Ay</option>` +
        MONTHS_TR.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
      month.value = data.bMonth || "";
      month.addEventListener("change", () => onInput({ bMonth: month.value }));

      const year = document.createElement("select");
      year.className = "field-select";
      const currentYear = new Date().getFullYear();
      const years = [];
      for (let y = currentYear; y >= 1925; y--) years.push(y);
      year.innerHTML = `<option value="">Yıl</option>` +
        years.map((y) => `<option value="${y}">${y}</option>`).join("");
      year.value = data.bYear || "";
      year.addEventListener("change", () => onInput({ bYear: year.value }));

      row.append(day, month, year);
      mountField(row);
      break;
    }
    case 3: {
      heading.textContent = "Nerede doğdun?";
      hint.textContent = "Şehir ve ülke yeterli.";
      const i = document.createElement("input");
      i.className = "field-input";
      i.placeholder = "Konya, Türkiye";
      i.value = data.birthPlace;
      i.autofocus = true;
      i.addEventListener("input", () => onInput({ birthPlace: i.value }));
      mountField(i);
      break;
    }
    case 4: {
      heading.textContent = "Eşinin adı?";
      hint.textContent = "İsteğe bağlı. Aşk haneni daha iyi okumak için.";
      const i = document.createElement("input");
      i.className = "field-input";
      i.placeholder = "Ayşe";
      i.value = data.spouseName ?? "";
      i.autofocus = true;
      i.addEventListener("input", () => onInput({ spouseName: i.value }));
      mountField(i);
      break;
    }
    case 5: {
      heading.textContent = "En çok neyi merak ediyorsun?";
      hint.textContent = "İsteğe bağlı. Yazarsan, müneccim hükmünü ona göre tartar.";
      const t = document.createElement("textarea");
      t.className = "field-textarea";
      t.placeholder = "Kariyer mi, aşk mı, yoksa başka bir şey mi?";
      t.value = data.question ?? "";
      t.autofocus = true;
      t.addEventListener("input", () => onInput({ question: t.value }));
      mountField(t);
      break;
    }
  }
  return wrap;
}

export function renderForm(router) {
  const root = tpl("tpl-form");
  const progressBar = root.querySelector(".progress-bar");
  const stepHost = root.querySelector(".step-host");
  const navBack = root.querySelector(".nav-back");
  const navSkip = root.querySelector(".nav-skip");
  const navNext = root.querySelector(".nav-next");

  const data = {
    name: "",
    motherName: "",
    birthDate: "",
    birthPlace: "",
    spouseName: "",
    question: "",
    bDay: "",
    bMonth: "",
    bYear: "",
  };
  let step = 0;

  const refreshNav = () => {
    // Step 0's "back" now goes to landing (a real in-app destination),
    // so the button is never disabled — just the label changes.
    navBack.disabled = false;
    navBack.textContent = step === 0 ? "← Ana sayfa" : "← Geri";
    navSkip.hidden = !(step === 4 || step === 5);
    navNext.disabled = !isValidStep(step, data);
    navNext.textContent =
      step === TOTAL_STEPS - 1 ? "Yıldızları Aç →" : "İlerle →";
    progressBar.style.width = `${((step + 1) / TOTAL_STEPS) * 100}%`;
  };

  const mountStep = () => {
    stepHost.replaceChildren(buildStepNode(step, data, (patch) => {
      Object.assign(data, patch);
      refreshNav();
    }));
    refreshNav();
    const first = stepHost.querySelector("input, select, textarea");
    if (first) first.focus();
  };

  navBack.addEventListener("click", () => {
    if (step > 0) {
      step -= 1;
      mountStep();
    } else {
      router.setStep("landing");
    }
  });

  navSkip.addEventListener("click", () => {
    if (step === 4) data.spouseName = "";
    if (step === 5) data.question = "";
    next();
  });

  const next = () => {
    if (!isValidStep(step, data)) return;
    if (step < TOTAL_STEPS - 1) {
      step += 1;
      mountStep();
      return;
    }
    // submit
    const payload = {
      name: data.name.trim(),
      motherName: data.motherName.trim(),
      birthDate: composeBirthDate(data),
      birthPlace: data.birthPlace.trim(),
    };
    if (data.spouseName?.trim()) payload.spouseName = data.spouseName.trim();
    if (data.question?.trim()) payload.question = data.question.trim();
    try {
      window.sessionStorage.setItem(FORM_SESSION_KEY, JSON.stringify(payload));
    } catch {
      /* ignore — loading view will surface */
    }
    // Sub-view switch — URL bar stays at "/" while the müneccim works.
    router.setStep("loading");
  };

  navNext.addEventListener("click", next);

  mountStep();
  return root;
}

// ----------------------------------------------------------------------------
// Loading
// ----------------------------------------------------------------------------

// Synchronous loading screen: POST /api/generate keeps the connection open
// for the ~2–3 minute LLM call (the Worker streams Anthropic's SSE response
// internally so neither the subrequest nor waitUntil limits trip). The
// loading surface itself is rich enough to sit through for two minutes —
// moon-phase cycle + constellation parade + phased status text + ambient
// Arabic letters drifting in the periphery.
const MIN_LOADING_MS = 2500;
const SVG_NS = "http://www.w3.org/2000/svg";

function pickPhase(elapsedSec) {
  let phaseIdx = 0;
  for (let i = 0; i < LOADING_PHASES.length; i++) {
    if (LOADING_PHASES[i].startSec <= elapsedSec) phaseIdx = i;
  }
  return phaseIdx;
}

function spawnConstellation(host, def) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 200 130");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.classList.add("constellation-svg");

  // Single path covering all the lines so stroke-dashoffset animates the
  // whole figure in one sweep.
  const path = document.createElementNS(SVG_NS, "path");
  let d = "";
  for (const [a, b] of def.lines) {
    const [ax, ay] = def.points[a];
    const [bx, by] = def.points[b];
    d += `M ${ax} ${ay} L ${bx} ${by} `;
  }
  path.setAttribute("d", d);
  path.classList.add("constellation-line");
  svg.appendChild(path);

  for (let i = 0; i < def.points.length; i++) {
    const [x, y] = def.points[i];
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", String(x));
    c.setAttribute("cy", String(y));
    c.setAttribute("r", "1.8");
    c.classList.add("constellation-star");
    c.style.animationDelay = (i * 0.22).toFixed(2) + "s";
    svg.appendChild(c);
  }

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", "100");
  text.setAttribute("y", "120");
  text.classList.add("constellation-name");
  text.textContent = def.name;
  svg.appendChild(text);

  host.appendChild(svg);
  requestAnimationFrame(() => svg.classList.add("show"));
  return svg;
}

function startConstellationParade(host) {
  let idx = Math.floor(Math.random() * CONSTELLATIONS.length);
  let current = null;
  let stopped = false;
  let timer = 0;

  const next = () => {
    if (stopped) return;
    if (current) {
      const old = current;
      old.classList.remove("show");
      window.setTimeout(() => old.remove(), 1200);
    }
    current = spawnConstellation(host, CONSTELLATIONS[idx % CONSTELLATIONS.length]);
    idx += 1;
    timer = window.setTimeout(next, 16000);
  };
  next();

  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    if (current) current.remove();
  };
}

function spawnHarf(host) {
  const letter = HARFLER[Math.floor(Math.random() * HARFLER.length)];
  const el = document.createElement("span");
  el.className = "ambient-harf";
  el.textContent = letter;
  el.style.left = (Math.random() * 80 + 8) + "%";
  el.style.top = (Math.random() * 75 + 12) + "%";
  host.appendChild(el);
  const anim = el.animate(
    [
      { opacity: 0, transform: "translateY(8px)" },
      { opacity: 0.55, transform: "translateY(-12px)", offset: 0.45 },
      { opacity: 0, transform: "translateY(-38px)" },
    ],
    { duration: 4500, easing: "ease-out", fill: "forwards" },
  );
  anim.onfinish = () => el.remove();
}

function startHarfler(host) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (!document.hidden) spawnHarf(host);
    const next = 4200 + Math.random() * 3000;
    window.setTimeout(tick, next);
  };
  // First one a bit delayed so the user sees the moon land first.
  window.setTimeout(tick, 1500);
  return () => {
    stopped = true;
  };
}

// Poll /api/reading/:id every ~3s until status is terminal (done or
// error) — or the soft cap is reached (~4 minutes, comfortably longer
// than a normal generation). Returns the final reading payload, or
// null if the poll loop was cancelled or timed out. `isCancelled` lets
// the caller (e.g. renderLoading on view-cleanup) bail when the user
// navigates away mid-poll.
async function pollReadingUntilTerminal(id, isCancelled) {
  const INTERVAL_MS = 3000;
  const MAX_ATTEMPTS = 80; // 80 × 3s = 240s
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    if (isCancelled()) return null;
    const data = await api.fetchReading(id).catch(() => null);
    if (isCancelled()) return null;
    if (data && (data.status === "done" || data.status === "error")) {
      return data;
    }
    await new Promise((r) => window.setTimeout(r, INTERVAL_MS));
  }
  return null;
}

// Copy a string to the clipboard with a non-secure-context fallback.
// navigator.clipboard.writeText only works in secure contexts (HTTPS,
// localhost, 127.0.0.1) — on 0.0.0.0 or any IP/lan host it rejects.
// The execCommand fallback works in basically any browser including
// non-secure contexts; deprecated but still universally supported and
// the only option for this case until we deploy.
async function copyToClipboard(text) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// The "Beklemek zorunda değilsin" escape-hatch panel surfaced under the
// loading animation. Two recovery paths for the user:
//   1. Type an email — server attaches it to the row; if the row is
//      already done by then, /api/reading/:id/email fires the "hazır"
//      email immediately (Phase 5 wiring).
//   2. Copy the okuma URL — they can close the tab and return later
//      to whatever state the reading is in.
// Both paths defeat the "user bounces on mobile and loses everything"
// failure mode that motivated the entire async refactor.
function buildEscapeHatch(readingId, isCancelled, initialHasEmail) {
  const panel = document.createElement("div");
  panel.className = "loading-escape";
  // Static structure: intro line + email slot (form OR confirmed text)
  // + copy-link button + transient status line. The email slot's
  // contents swap between "ask" and "confirmed" based on state — the
  // copy-link and status survive across both, so the user can still
  // copy regardless of email state.
  panel.innerHTML = `
    <p class="loading-escape-label"></p>
    <div class="loading-escape-email-slot"></div>
    <button type="button" class="loading-escape-copy">↗ Bağlantını kopyala ve sonra kontrol et</button>
    <p class="loading-escape-status" aria-live="polite"></p>
  `;
  const labelEl = panel.querySelector(".loading-escape-label");
  const slotEl = panel.querySelector(".loading-escape-email-slot");
  const statusEl = panel.querySelector(".loading-escape-status");
  const setStatus = (msg, tone = "") => {
    if (isCancelled()) return;
    statusEl.textContent = msg;
    statusEl.dataset.tone = tone;
  };

  const renderAsk = () => {
    labelEl.textContent =
      "Eski usul saatler isterdi; bu okuma 2-3 dakika sürer. Beklemek istemezsen:";
    slotEl.innerHTML = `
      <form class="loading-escape-email" novalidate>
        <input type="email" placeholder="e-posta" autocomplete="email" required />
        <button type="submit" class="loading-escape-btn">Hazır olunca yaz</button>
      </form>
    `;
    slotEl
      .querySelector(".loading-escape-email")
      .addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const input = slotEl.querySelector("input[type=email]");
        const btn = slotEl.querySelector(".loading-escape-btn");
        const email = input.value.trim();
        if (!email || !email.includes("@")) {
          setStatus("Geçerli bir e-posta yaz.", "warn");
          return;
        }
        btn.disabled = true;
        setStatus("Kaydediliyor…");
        try {
          await api.attachEmail(readingId, email);
          if (isCancelled()) return;
          renderConfirmed();
          setStatus("", "");
        } catch (err) {
          setStatus("Kaydedilemedi — sonra tekrar dene.", "warn");
          btn.disabled = false;
        }
      });
  };

  const renderConfirmed = () => {
    // Tighter intro when there's already a confirmed email — the
    // "beklemek istemezsen:" preamble doesn't lead anywhere now that
    // the form is gone, so we drop the "veya bekle" framing.
    labelEl.textContent =
      "Eski usul saatler isterdi; bu okuma 2-3 dakika sürer.";
    slotEl.innerHTML = `<p class="loading-escape-confirmed">✓ E-postanı aldım — yıldıznamen hazır olduğunda sana yazarım.</p>`;
  };

  if (initialHasEmail) renderConfirmed();
  else renderAsk();

  panel
    .querySelector(".loading-escape-copy")
    .addEventListener("click", async () => {
      const url = `${window.location.origin}/okuma/${encodeURIComponent(readingId)}`;
      const ok = await copyToClipboard(url);
      if (ok) {
        setStatus("✓ Bağlantı kopyalandı — istediğin zaman geri dön.", "ok");
      } else {
        // Last resort: still surface the URL so the user can long-press
        // and copy by hand. Hits on locked-down in-app browsers.
        setStatus("Kopyalanamadı, elle kopyala: " + url, "warn");
      }
    });

  return panel;
}

// The shared mystical-loading experience. Mounts the full tpl-loading
// visual (moon, constellation parade, harfler, phased text rotation,
// reassurance footnote) + the escape-hatch panel + polling, as a fixed
// full-viewport overlay on top of `parentEl`. Used by:
//   - renderLoading        — first-time form-submit ritual
//   - renderResult pending — bounce-recovery on /okuma/:id when the row
//                            is still being generated
//   so the visual experience is identical regardless of how the user
//   arrived. Returns { cleanup } so the caller can tear it all down
//   (used both on view-unmount and on natural completion).
//
// Callbacks:
//   onDone(data)   — terminal status='done'; data is the full reading
//   onError(msg)   — terminal status='error', or poll timeout (~4 min)
function mountLoadingExperience(parentEl, opts) {
  const { readingId, isCancelled, hasEmail, onDone, onError } = opts;
  const tplNode = tpl("tpl-loading");
  const overlay = document.createElement("div");
  overlay.className = "loading-overlay-fixed";
  overlay.appendChild(tplNode);

  const primaryEl = overlay.querySelector(".loading-primary");
  const secondaryEl = overlay.querySelector(".loading-secondary");
  const constellationHost = overlay.querySelector(".constellation-host");
  const harflerHost = overlay.querySelector(".harfler-host");

  let stopped = false;
  const startedAt = Date.now();

  // Constellation parade + harfler — ambient self-scheduling animations.
  const stopConstellations = startConstellationParade(constellationHost);
  const stopHarfler = startHarfler(harflerHost);

  // Phased text. Initial render is immediate (no fade); subsequent
  // rotations fade out → swap → fade in. Each phase has 3 primary + 3
  // secondary lines that cycle within the phase every ~4.5s.
  let phaseIdx = 0;
  let lineIdx = 0;
  const swap = (el, text) => {
    el.style.opacity = "0";
    window.setTimeout(() => {
      if (stopped) return;
      el.textContent = text;
      el.style.opacity = "1";
    }, 280);
  };
  const rotate = () => {
    if (stopped) return;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const newPhaseIdx = pickPhase(elapsedSec);
    if (newPhaseIdx !== phaseIdx) {
      phaseIdx = newPhaseIdx;
      lineIdx = 0;
    } else {
      lineIdx += 1;
    }
    const phase = LOADING_PHASES[phaseIdx];
    swap(primaryEl, phase.primary[lineIdx % phase.primary.length]);
    swap(secondaryEl, phase.secondary[lineIdx % phase.secondary.length]);
  };
  primaryEl.textContent = LOADING_PHASES[0].primary[0];
  secondaryEl.textContent = LOADING_PHASES[0].secondary[0];
  primaryEl.style.opacity = "1";
  secondaryEl.style.opacity = "1";
  const textTimer = window.setInterval(rotate, 4500);

  overlay.appendChild(
    buildEscapeHatch(readingId, () => stopped || isCancelled(), hasEmail),
  );
  parentEl.appendChild(overlay);

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(textTimer);
    stopConstellations();
    stopHarfler();
    overlay.remove();
  };

  // Polling — runs concurrently with the animation timers above. The
  // poll helper takes `isCancelled`; we pass a guard that combines the
  // overlay-stopped flag with the caller's signal.
  (async () => {
    const final = await pollReadingUntilTerminal(
      readingId,
      () => stopped || isCancelled(),
    );
    if (stopped || isCancelled()) return;
    if (!final) {
      onError("Yıldızlar fazla yavaş hizalanıyor — sayfayı yenile.");
      return;
    }
    if (final.status === "error") {
      onError(final.error || "Yıldızlar bugün karanlık. Sonra tekrar dene.");
      return;
    }
    onDone(final);
  })();

  return { cleanup };
}

export function renderLoading(router) {
  // Thin shell — the actual mystical loading view is mounted by
  // mountLoadingExperience below. This view exists for ~100ms (until
  // /api/generate returns the id and we hand off to the shared helper),
  // then the shell stays as the host element under the fixed overlay.
  const root = document.createElement("div");
  root.className = "view view-loading-shell";

  let cancelled = false;
  let navTimer = 0;
  let loadingHandle = null;

  const cleanup = () => {
    cancelled = true;
    if (navTimer) window.clearTimeout(navTimer);
    if (loadingHandle) loadingHandle.cleanup();
  };
  root.addEventListener("view:cleanup", cleanup);

  // Error UI is shared between "couldn't enqueue" and "generation
  // failed" paths. Mounts a centred message + a "Tekrar dene" button
  // that sends the user back to the form.
  const showError = (message) => {
    if (cancelled) return;
    if (loadingHandle) loadingHandle.cleanup();
    root.innerHTML = "";
    const card = document.createElement("div");
    card.className = "loading-error-card";
    const msg = document.createElement("p");
    msg.className = "loading-error-msg";
    msg.textContent = message || "Yıldızlar şu an okunamıyor.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-gold-outline";
    btn.textContent = "Tekrar dene";
    btn.addEventListener("click", () => router.setStep("form"));
    card.append(msg, btn);
    root.appendChild(card);
  };

  const submit = async () => {
    let form = null;
    try {
      const raw = window.sessionStorage.getItem(FORM_SESSION_KEY);
      if (raw) form = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    if (!form) {
      router.setStep("form");
      return;
    }
    const submitStartedAt = Date.now();
    try {
      // Producer call — fast (~100ms). Returns {id, status:"pending"};
      // the real LLM work runs in the queue consumer, decoupled from
      // this request's lifetime. From here on the user can bounce, lock
      // the phone, switch apps — generation still completes.
      const initial = await api.generateReading(form);
      if (cancelled) return;
      if (!initial.id) {
        throw new Error(initial.error || "Müneccim sustu.");
      }
      const readingId = initial.id;
      // URL bar reflects the real okuma URL while the wait continues —
      // share, refresh, address-bar copy all work; refresh lands on
      // renderResult which itself mounts the same loading experience.
      try {
        window.history.replaceState(
          {},
          "",
          `/okuma/${encodeURIComponent(readingId)}`,
        );
      } catch {
        /* ignore */
      }
      loadingHandle = mountLoadingExperience(root, {
        readingId,
        isCancelled: () => cancelled,
        // Just-created row: customer_email is null on the server, so
        // start the escape hatch in its "ask" state.
        hasEmail: false,
        onDone: () => {
          if (cancelled) return;
          // Give the animation a beat of dignity for instant-complete
          // edge cases (e.g. the consumer already finished a duplicate
          // retry mid-flight).
          const elapsed = Date.now() - submitStartedAt;
          const wait = Math.max(0, MIN_LOADING_MS - elapsed);
          navTimer = window.setTimeout(() => {
            if (cancelled) return;
            try {
              window.sessionStorage.removeItem(FORM_SESSION_KEY);
              window.sessionStorage.setItem(JOURNEY_FLAG, "1");
            } catch {
              /* ignore */
            }
            router.navigate(`/okuma/${encodeURIComponent(readingId)}`, {
              replace: true,
            });
          }, wait);
        },
        onError: showError,
      });
    } catch (err) {
      showError(err.message);
    }
  };

  // Defer one tick so the view mounts before fetch starts.
  setTimeout(submit, 0);

  return root;
}

// ----------------------------------------------------------------------------
// Result
// ----------------------------------------------------------------------------

function paragraphHtml(text) {
  return text
    .split(/\n+/)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const PLAY_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M2 1 L13 7 L2 13 Z"/></svg>`;
const PAUSE_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="3" height="12"/><rect x="9" y="1" width="3" height="12"/></svg>`;

// Smoothly ramp the audio volume from `from` → `to` over `durationMs` using
// requestAnimationFrame. Used for the autoplay fade-in so the müneccim
// doesn't slap the user with full volume on the first syllable.
function fadeVolume(audio, from, to, durationMs) {
  audio.volume = from;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    audio.volume = from + (to - from) * t;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Build a native <audio>-backed player for one (reading, section).
// Returns { wrap, audio, dispose } — the caller wires dispose into the
// view-cleanup hook so audio stops on navigation away.
//
// `sectionKey` accepts either a string (single audio file, the common
// case) or an array of section keys (played back-to-back through a
// single <audio> element as one logical track). The array form exists
// to support the paid karakterinOzu = ["karakterinOzu", "karakterinOzuRest"]
// flow without re-synthesising the preview portion that's already
// cached from the free state. Play/pause/stop UI controls the compound
// playback as one thing; the user has no idea it's two files.
function makeAudioPlayer({
  readingId,
  sectionKey,
  chunkCounts,
  autoplay = false,
  manuallyStopped,
}) {
  const wrap = document.createElement("div");
  wrap.className = "audio-player";

  // Normalise sectionKey to a list of conceptual sections to play
  // (today: a single section name, or in karakterinOzu's case
  // ["karakterinOzu", "karakterinOzuRest"] to chain preview→rest after
  // unlock). Then expand each section into its chunk refs using the
  // chunkCounts manifest from /api/reading/:id — every served file is
  // a small per-(section, chunkIdx) MP3 with a known Content-Length,
  // which is what lets mobile <audio> play long sections to the end
  // without the chunked-EOF cutoff that bit us on the v3 path.
  const sectionList = Array.isArray(sectionKey) ? sectionKey : [sectionKey];
  const primaryKey = sectionList[0];
  const queue = [];
  for (const sec of sectionList) {
    const n = (chunkCounts && chunkCounts[sec]) || 0;
    for (let i = 0; i < n; i++) queue.push({ section: sec, chunkIdx: i });
  }
  let queuePos = 0;

  const audio = new Audio();
  audio.preload = autoplay ? "auto" : "none";
  if (queue.length > 0) {
    audio.src = api.ttsChunkUrl(
      readingId,
      queue[0].section,
      queue[0].chunkIdx,
    );
  }

  // Prefetch the next N chunks ahead of the playback head so by the
  // time the audio element rolls into them, they're already in the
  // browser's HTTP cache (responses carry Cache-Control:
  // max-age=1296000, immutable). Without this, each `ended` event has
  // to wait a full Worker → R2 (or worse, ElevenLabs synth) round-trip
  // before the next chunk starts — exactly the gappy experience we
  // designed chunking to avoid. PREFETCH_AHEAD=2 caps total concurrent
  // upstream load at 3 (one audio element + two prefetches), matching
  // the ElevenLabs concurrency limit on our plan. Single AbortController
  // for all prefetches so dispose() cancels them in one shot.
  const PREFETCH_AHEAD = 2;
  const prefetched = new Set();
  let prefetchAbort = null;
  const prefetchAhead = (pos) => {
    for (let i = 1; i <= PREFETCH_AHEAD; i += 1) {
      const targetPos = pos + i;
      if (targetPos >= queue.length) break;
      const ref = queue[targetPos];
      const url = api.ttsChunkUrl(readingId, ref.section, ref.chunkIdx);
      if (prefetched.has(url)) continue;
      prefetched.add(url);
      if (!prefetchAbort) prefetchAbort = new AbortController();
      fetch(url, { signal: prefetchAbort.signal }).catch(() => {
        // Prefetch failure (abort, network blip, 502): drop from set
        // so the audio element can re-request when it reaches this
        // chunk. No user-visible error here — the audio element's own
        // error handler is the one that surfaces failures.
        prefetched.delete(url);
      });
    }
  };

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "audio-btn play";
  playBtn.setAttribute("aria-label", "Dinle");
  playBtn.innerHTML = PLAY_ICON;

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "audio-btn stop";
  stopBtn.disabled = true;
  stopBtn.setAttribute("aria-label", "Durdur");
  stopBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10"/></svg>`;

  const waveform = document.createElement("div");
  waveform.className = "waveform";
  waveform.innerHTML = `<span></span><span></span><span></span>`;

  const label = document.createElement("span");
  label.className = "audio-label";
  label.textContent = "Sesli dinle";

  wrap.append(playBtn, stopBtn, waveform, label);

  const setUiPlaying = () => {
    playBtn.innerHTML = PAUSE_ICON;
    playBtn.classList.remove("pulse", "loading");
    waveform.classList.add("active");
    stopBtn.disabled = false;
    label.textContent = "Müneccim okuyor…";
  };
  const setUiPaused = () => {
    playBtn.innerHTML = PLAY_ICON;
    waveform.classList.remove("active");
    label.textContent = "Duraklatıldı";
  };
  const setUiIdle = (msg = "Sesli dinle") => {
    playBtn.innerHTML = PLAY_ICON;
    waveform.classList.remove("active");
    stopBtn.disabled = true;
    label.textContent = msg;
  };
  const setUiLoading = () => {
    playBtn.classList.add("loading");
    label.textContent = "Hazırlanıyor…";
  };

  audio.addEventListener("waiting", setUiLoading);
  audio.addEventListener("playing", () => {
    setUiPlaying();
    // Fired every time audio actually begins (initial play, resume from
    // pause, or chunk switch). prefetchAhead is idempotent — already-
    // prefetched URLs are skipped — so this is safe to call repeatedly.
    prefetchAhead(queuePos);
  });
  audio.addEventListener("pause", () => {
    if (!audio.ended) setUiPaused();
  });
  audio.addEventListener("ended", () => {
    // Advance the chunk queue. Single-chunk sections drop straight into
    // the setUiIdle() branch (queuePos was 0, becomes 1, queue.length
    // was 1 → not <). Multi-chunk sections (long locked sections, or
    // post-unlock karakterinOzu + karakterinOzuRest chain) walk through
    // chunks 0..N-1; each switch is a fast R2 hit since prior chunks
    // got cached by the first listener.
    if (queuePos + 1 < queue.length) {
      queuePos += 1;
      const next = queue[queuePos];
      audio.src = api.ttsChunkUrl(readingId, next.section, next.chunkIdx);
      const p = audio.play();
      if (p && typeof p.then === "function") p.catch(() => setUiIdle());
    } else {
      setUiIdle();
    }
  });
  audio.addEventListener("error", () => {
    playBtn.classList.remove("loading", "pulse");
    // Mid-queue error on a multi-chunk track (e.g. a later karakterinOzuRest
    // chunk 404s because the rest text was unusually short). Treat as a
    // graceful end-of-playback rather than surfacing an error — the user
    // already heard the meaningful audio in earlier chunks.
    if (queuePos > 0) {
      setUiIdle();
      return;
    }
    // First-chunk failure = real TTS pipeline failure (server-side 5xx,
    // ElevenLabs upstream down, quota exhausted, network blip). Stay
    // in-voice — müneccim-anthropomorphism, no technical disclosure.
    // Mirrors the server-side error string in src/index.ts.
    setUiIdle("Müneccim'in sesi şu an gelmiyor. Birazdan tekrar dene.");
  });

  playBtn.addEventListener("click", () => {
    playBtn.classList.remove("pulse");
    if (audio.paused) {
      // Funnel tracking — fire only on play (start), not pause/resume,
      // and not on inter-segment transitions within a compound track.
      // primaryKey is the conceptual section (karakterinOzu vs. a locked
      // one) regardless of which compound segment we'd play next.
      api.trackEvent(
        readingId,
        primaryKey === "karakterinOzu" ? "listened_free" : "listened_locked",
      );
      const p = audio.play();
      if (p && typeof p.then === "function") p.catch(() => setUiIdle());
    } else {
      audio.pause();
    }
  });

  stopBtn.addEventListener("click", () => {
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      /* may throw if metadata not loaded yet */
    }
    // Reset queue back to the first chunk so a subsequent play starts
    // from the beginning of the track, not from mid-section.
    if (queuePos !== 0 && queue.length > 0) {
      queuePos = 0;
      audio.src = api.ttsChunkUrl(
        readingId,
        queue[0].section,
        queue[0].chunkIdx,
      );
    }
    if (manuallyStopped) manuallyStopped();
    setUiIdle();
  });

  // Autoplay attempt. Modern browsers reject the play() Promise when there's
  // no recent user gesture (iOS Safari is the strictest); in that case we
  // pulse the play button instead of failing silently.
  if (autoplay) {
    fadeVolume(audio, 0, 1, 2000);
    const p = audio.play();
    if (p && typeof p.then === "function") {
      p.catch(() => {
        audio.volume = 1; // restore so a manual click plays at normal volume
        playBtn.classList.add("pulse");
      });
    }
  }

  const dispose = () => {
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      /* ignore */
    }
    // Cancel any in-flight chunk prefetches when the player goes away
    // (user navigated, view re-rendered). Completed prefetches stay in
    // the browser HTTP cache — they'll still be hot if the same reading
    // is opened again.
    if (prefetchAbort) {
      prefetchAbort.abort();
      prefetchAbort = null;
    }
  };

  return { wrap, audio, dispose };
}

// makeSection returns { node, dispose } for unlocked sections (so the
// caller can pause audio on view-cleanup) or { node, dispose: noop } for
// locked sections. Caller passes `manuallyStopped` to be notified when the
// user pressed the stop button — used to keep the journey-autoplay one-shot.
function makeSection({
  title,
  text,
  locked,
  readingId,
  sectionKey,
  chunkCounts,
  autoplay,
  manuallyStopped,
  counter,
}) {
  const section = document.createElement("section");
  section.className = "section" + (locked ? " locked" : "");

  const h3 = document.createElement("h3");
  h3.textContent = title;
  section.appendChild(h3);

  // Optional caption directly under the title — used on karakterinOzu in
  // the free-preview state to tell the user "this is just the first
  // section, nine more are locked". Sits tight under h3, doesn't get its
  // own section break.
  if (counter) {
    const counterEl = document.createElement("p");
    counterEl.className = "section-counter";
    counterEl.textContent = counter;
    section.appendChild(counterEl);
  }

  const body = document.createElement("div");
  body.className = "section-body";

  if (locked) {
    body.innerHTML = `
      <p>················································ ······· ···········</p>
      <p>·········· ·············· ······ ·············· ······· ··········</p>
      <p>········· ······ ········· ········ ··········· ···············</p>
    `;
  } else {
    body.innerHTML = paragraphHtml(text);
  }
  section.appendChild(body);

  if (locked) {
    const overlay = document.createElement("div");
    overlay.className = "lock-overlay";
    overlay.innerHTML = `
      <svg width="28" height="32" viewBox="0 0 28 32" fill="none" aria-hidden="true">
        <path d="M6 14 V10 a8 8 0 0 1 16 0 v4" stroke="#c9a84c" stroke-width="1.5" stroke-linecap="round" />
        <rect x="4" y="14" width="20" height="14" rx="1.5" stroke="#c9a84c" stroke-width="1.5" fill="rgba(10,14,26,0.4)"/>
        <circle cx="14" cy="21" r="1.5" fill="#e8d08a" />
      </svg>
    `;
    section.appendChild(overlay);
    return { node: section, dispose: () => {} };
  }

  const player = makeAudioPlayer({
    readingId,
    sectionKey,
    chunkCounts,
    autoplay,
    manuallyStopped,
  });
  // Insert the audio player between the title and the body so the user can
  // tap Dinle before reading, and the read+listen experience starts in sync.
  section.insertBefore(player.wrap, body);
  return { node: section, dispose: player.dispose };
}

// (LOCK_GLYPH_HTML removed in the action-bar consolidation — free state
// no longer renders disabled "locked" buttons; the paid-only icons are
// simply absent from the bar until unlock, and the paid features are
// communicated by the unlock card's feature list + the modal.)

// In-app browsers (Instagram, Facebook, TikTok, X, etc.) ship
// navigator.share but implement it badly. Instagram's iOS in-app
// webview in particular shows a free-text modal with non-functional
// Cancel/OK buttons — the user has to manually select and copy the URL
// from the modal body. Facebook's is similar. We treat these like
// desktop (clipboard copy + visual confirmation) so the user gets a
// reliable share path. UA-sniffing is the only signal here; there's no
// standardised capability check for "your native share sheet is sane".
function isInAppBrowser() {
  const ua = navigator.userAgent || "";
  return /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Twitter|TikTok|musical_ly|Bytedance|Snapchat|LinkedInApp|MicroMessenger|KAKAOTALK|Line\//i.test(
    ua,
  );
}

// Native share sheet on touch-primary devices (mobile), clipboard copy on
// everything else. Why not navigator.share everywhere it exists? — macOS
// Safari ships navigator.share but its share sheet has no "Copy" option
// (Apple's deliberate choice, ~5y-old complaint, unlikely to change). On
// desktop the user almost certainly wants Copy as the primary action, so we
// skip the native sheet there. We also skip it inside in-app webviews
// (Instagram/FB/TikTok/etc.) because their navigator.share is broken (see
// isInAppBrowser above). matchMedia('(hover: none) and (pointer: coarse)')
// is the standard CSS-level "this is a touch device" probe.
async function handleShare(btn) {
  const url = window.location.href;
  const shareData = {
    url,
    title: "Yıldızname",
    text: "Müneccim yıldıznamemi okudu.",
  };
  const isTouchPrimary = window.matchMedia(
    "(hover: none) and (pointer: coarse)",
  ).matches;
  const useNativeShare =
    isTouchPrimary && navigator.share && !isInAppBrowser();

  try {
    if (useNativeShare) {
      // Mobile in a real browser: native share sheet (iOS Safari includes
      // Copy here; Android's share sheet is rich with messaging apps).
      await navigator.share(shareData);
      // Native UI handles its own confirmation — no in-app feedback needed.
    } else if (navigator.clipboard?.writeText) {
      // Desktop (incl. macOS Safari): copy + visible confirmation.
      await navigator.clipboard.writeText(url);
      const original = btn.textContent;
      btn.textContent = "Kopyalandı ✓";
      btn.disabled = true;
      window.setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 2000);
    } else {
      // Last-resort fallback for very old browsers.
      window.prompt("Bağlantıyı kopyala:", url);
    }
  } catch {
    // User dismissed the share sheet, or clipboard threw — silent no-op
    // (button stays as-is, ready to be clicked again).
  }
}

// Price is revealed exclusively in the unlock modal — kept off the inline
// CTA labels so the user only encounters the number once they've engaged
// with the reveal. The string here is the hardcoded display label inside
// the modal; the server uses READING_PRICE_TRY from wrangler.toml for the
// actual charge amount. If you change the price, update wrangler.toml AND
// this constant AND public/sss.html.
const PRICE_LABEL = "349,99 ₺";

// Shared button label used by both the inline payment blocks and the
// modal CTA. Same wording on purpose — clicking the inline button opens
// the modal, the modal's CTA performs the actual unlock; the consistent
// label makes the two-step flow feel like one continuous action.
const PAYMENT_CTA_LABEL = "Kaderinin tamamını aç →";

// Action-bar primary pill labels for the paid "Baştan Sona Dinle" chain
// button. The chain logic toggles textContent between these two; the play/
// pause glyph is baked into the string (textContent replaces children, so
// a separate icon element would get clobbered on toggle).
const LISTEN_IDLE = "▶ Baştan Sona Dinle";
const LISTEN_PLAYING = "⏸ Sesi Durdur";

// Shared unlock flow. Reached via the reveal modal's CTA, which every
// unlock entry point (unlock card, sticky, inline "Devamını oku") opens.
// Calls /api/unlock which now returns a
// Stripe Checkout URL; the browser is redirected there. On Stripe success,
// the redirect lands back on /okuma/:id?paid=1&session=... where
// renderResult's post-payment polling handles the wait for the webhook.
//
// Idempotent on already-paid readings: server returns { alreadyUnlocked:
// true } in which case we just refresh the page so the unlocked state
// renders.
async function performUnlock(id, router, btn, errEl, restoreLabel) {
  // Funnel tracking — fire-and-forget. `keepalive: true` on the fetch
  // ensures the request lands even though we're about to navigate away
  // to Stripe Checkout. Doesn't block the unlock flow on failure.
  api.trackEvent(id, "clicked_unlock");
  btn.disabled = true;
  btn.textContent = "Ödeme sayfasına yönlendiriliyor…";
  if (errEl) errEl.hidden = true;
  try {
    const res = await api.startCheckout(id);
    if (res.alreadyUnlocked) {
      // Race condition: webhook fired between modal-open and CTA-click.
      // Reload so the unlocked state renders.
      router.navigate(`/okuma/${encodeURIComponent(id)}`, { replace: true });
      return;
    }
    if (!res.url) throw new Error(res.error ?? "Ödeme başlatılamadı.");
    // Hard redirect to Stripe Checkout. After payment, Stripe redirects
    // back to /okuma/:id?paid=1&session=cs_... where the result page's
    // own polling logic takes over.
    window.location.assign(res.url);
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Bilinmeyen hata.";
      errEl.hidden = false;
    }
    btn.disabled = false;
    btn.textContent = restoreLabel;
  }
}

// Wires the unlock reveal modal: in-flow entry points (unlock card button
// + inline "Devamını oku →" link) → open it; close affordances; CTA →
// performUnlock. Returns openModal so the caller can also wire the action
// bar's free-state primary pill to it. The modal is the single place that
// performs the actual unlock + shows the price, regardless of which entry
// point opened it.
function wireUnlockModal({ root, id, router, disposables }) {
  const modal = root.querySelector(".unlock-modal");
  const modalCta = root.querySelector(".unlock-modal-cta");
  const modalClose = root.querySelector(".unlock-modal-close");
  const modalError = root.querySelector(".unlock-modal-error");
  if (!modal || !modalCta) return () => {};

  // Open in a clean state — clear any error/loading from a prior attempt.
  const openModal = () => {
    if (modalError) modalError.hidden = true;
    modalCta.disabled = false;
    modalCta.textContent = PAYMENT_CTA_LABEL;
    modal.showModal();
  };

  // In-flow entry points: the unlock card button + the inline "Devamını
  // oku →" link. (The action bar's primary pill is wired by the caller.)
  for (const btn of root.querySelectorAll(
    ".unlock-card .btn-gold-fill, .devamini-oku-inline",
  )) {
    btn.addEventListener("click", openModal);
    // Inline link is an <a> without href → add Enter/Space activation.
    if (btn.classList.contains("devamini-oku-inline")) {
      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openModal();
        }
      });
    }
  }

  // Close affordances: × button, backdrop click, native ESC.
  if (modalClose) modalClose.addEventListener("click", () => modal.close());
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) modal.close();
  });

  // CTA → actual unlock.
  modalCta.addEventListener("click", () => {
    performUnlock(id, router, modalCta, modalError, PAYMENT_CTA_LABEL);
  });

  disposables.push(() => {
    if (modal.open) modal.close();
  });

  return openModal;
}

// Wires the feedback modal: the 5-star (required) widget + optional
// textarea + submit + close affordances. Returns openModal so the action
// bar's "Yorum" icon can open it. `onSubmitted` is called after a
// successful submit so the caller can retire the Yorum icon (one-shot).
function wireFeedbackModal({ root, id, disposables, onSubmitted }) {
  const modal = root.querySelector(".feedback-modal");
  const formEl = root.querySelector(".feedback-form");
  const thanksEl = root.querySelector(".feedback-thanks");
  const stars = Array.from(root.querySelectorAll(".feedback-star"));
  const textEl = root.querySelector(".feedback-text");
  const submitEl = root.querySelector(".feedback-submit");
  const errorEl = root.querySelector(".feedback-error");
  const closeEl = root.querySelector(".feedback-modal-close");
  const thanksCloseEl = root.querySelector(".feedback-thanks-close");
  if (!modal || !submitEl || stars.length === 0) return () => {};

  // ----- star rating widget -----
  let rating = 0;
  const paint = (upto) => {
    stars.forEach((s, i) => s.classList.toggle("lit", i < upto));
  };
  const setRating = (val) => {
    rating = val;
    stars.forEach((s, i) => s.setAttribute("aria-checked", String(i + 1 === val)));
    paint(val);
    submitEl.disabled = rating < 1;
  };
  stars.forEach((star, i) => {
    const val = i + 1;
    star.addEventListener("click", () => setRating(val));
    star.addEventListener("mouseenter", () => paint(val));
    star.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        setRating(val);
      }
    });
  });
  // Restore the chosen rating's paint when the mouse leaves the row.
  const starsRow = root.querySelector(".feedback-stars");
  if (starsRow) starsRow.addEventListener("mouseleave", () => paint(rating));

  // ----- modal open/close -----
  const openModal = () => {
    if (errorEl) errorEl.hidden = true;
    modal.showModal();
    api.trackEvent(id, "clicked_feedback_cta");
  };
  if (closeEl) closeEl.addEventListener("click", () => modal.close());
  if (thanksCloseEl) thanksCloseEl.addEventListener("click", () => modal.close());
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) modal.close();
  });

  // ----- submit -----
  submitEl.addEventListener("click", async () => {
    if (rating < 1) return;
    submitEl.disabled = true;
    submitEl.textContent = "Gönderiliyor…";
    if (errorEl) errorEl.hidden = true;
    try {
      const text = textEl ? textEl.value.trim() : "";
      await api.submitFeedback(id, rating, text);
      // Morph to the thank-you state; let the caller retire the trigger.
      if (formEl) formEl.hidden = true;
      if (thanksEl) thanksEl.hidden = false;
      if (onSubmitted) onSubmitted();
    } catch (e) {
      submitEl.disabled = false;
      submitEl.textContent = "Müneccime ulaştır";
      if (errorEl) {
        errorEl.textContent = e.message || "Geri bildirim kaydedilemedi.";
        errorEl.hidden = false;
      }
    }
  });

  disposables.push(() => {
    if (modal.open) modal.close();
  });

  return openModal;
}

// The single unlock card (Lean CTA system). Replaces the old top+bottom
// payment blocks and the disabled locked-actions blocks. Title + price +
// text feature-list (what you unlock) + one primary gold-fill button.
// No click handler here — wireUnlockModal attaches one (via the
// `.unlock-card .btn-gold-fill` selector) that opens the reveal modal;
// the modal's CTA is the single thing that calls performUnlock.
function makeUnlockCard() {
  const card = document.createElement("div");
  card.className = "unlock-card";
  card.innerHTML = `
    <h3 class="unlock-card-title">Kaderinin tamamını aç</h3>
    <p class="unlock-card-price">349,99 ₺</p>
    <ul class="unlock-features">
      <li>Dokuz bölüm daha</li>
      <li>Müneccim sesiyle baştan sona sesli okuma</li>
      <li>PDF olarak indir</li>
    </ul>
    <button type="button" class="btn-gold-fill unlock-card-cta">${PAYMENT_CTA_LABEL}</button>
  `;
  return card;
}

// On Stripe redirect (?paid=1), the webhook may not have flipped the row
// to unlocked yet. Poll every second for up to ~10s; bail out and render
// whatever state we end up with at the end (probably still locked — at
// which point we surface a friendly "still processing" message).
const POST_PAYMENT_POLL_MS = 1000;
const POST_PAYMENT_POLL_MAX_ATTEMPTS = 12; // 12 × 1s = 12 seconds total

async function fetchReadingMaybePolling(id, expectUnlocked) {
  if (!expectUnlocked) return api.fetchReading(id);

  for (let attempt = 0; attempt < POST_PAYMENT_POLL_MAX_ATTEMPTS; attempt++) {
    const data = await api.fetchReading(id).catch(() => null);
    if (data && data.unlocked) return data;
    await new Promise((r) => setTimeout(r, POST_PAYMENT_POLL_MS));
  }
  // Last attempt — return whatever we get even if still locked. The UI
  // will show a "still processing" hint in that case.
  return api.fetchReading(id);
}

export function renderResult(router, { id, paidRedirect, unlockedQuery }) {
  const root = tpl("tpl-result");
  const kapakSozuEl = root.querySelector(".kapak-sozu");
  const sectionsHost = root.querySelector(".sections-host");
  const actionBar = root.querySelector(".action-bar");

  // Post-payment polling overlay — only shown when ?paid=1 is in the URL.
  // The user is staring at this for up to ~10 seconds while the webhook
  // flips the row in D1. Without it the page would render the locked
  // state for a few seconds, which would be confusing right after paying.
  let pollingOverlay = null;
  if (paidRedirect) {
    pollingOverlay = document.createElement("div");
    pollingOverlay.className = "post-payment-overlay";
    pollingOverlay.innerHTML = `
      <div class="post-payment-card">
        <div class="post-payment-spinner" aria-hidden="true"></div>
        <p class="post-payment-title shimmer-gold">Ödemen onaylandı.</p>
        <p class="post-payment-body">Yıldıznamen açılıyor — bir an…</p>
      </div>
    `;
    root.appendChild(pollingOverlay);
  }

  // initial placeholder while we fetch
  kapakSozuEl.textContent = paidRedirect ? "Mühür kırılıyor…" : "Okuma açılıyor…";

  // `cancelled` is checked by the bounce-recovery poll loop below so it
  // bails when the user navigates away mid-poll. Set via the disposables
  // pipeline so cleanup goes through the same path as everything else.
  let cancelled = false;
  // Track every disposable (per-section audio + the chain-play audio) so we
  // can stop them all if the user navigates away.
  const disposables = [];
  disposables.push(() => {
    cancelled = true;
  });
  const chainAudio = new Audio();
  chainAudio.preload = "none";
  disposables.push(() => {
    try {
      chainAudio.pause();
      chainAudio.removeAttribute("src");
      chainAudio.load();
    } catch {
      /* ignore */
    }
  });

  root.addEventListener("view:cleanup", () => {
    for (const d of disposables) d();
  });

  // Funnel tracking — fires once when the user scrolls beyond a threshold
  // that suggests real engagement with content below the fold (past the
  // free section header on most devices). Single-fire then unbinds, so
  // no perf hit beyond the brief pre-threshold period. `keepalive` on
  // the fetch ensures the event survives a navigation away.
  const SCROLL_THRESHOLD_PX = 200;
  const onScroll = () => {
    if (window.scrollY > SCROLL_THRESHOLD_PX) {
      api.trackEvent(id, "scrolled_past_free");
      window.removeEventListener("scroll", onScroll);
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  disposables.push(() => window.removeEventListener("scroll", onScroll));

  // Consume the journey flag exactly once. Set in renderLoading right before
  // /result navigation; absent on refreshes, shared links, back-button.
  let journeyAutoplay = false;
  try {
    if (window.sessionStorage.getItem(JOURNEY_FLAG) === "1") {
      journeyAutoplay = true;
      window.sessionStorage.removeItem(JOURNEY_FLAG);
    }
  } catch {
    /* ignore */
  }
  // If the user manually stops the autoplay, don't auto-do-anything else this
  // session. Conservative: even subsequent locked-section playback is purely
  // opt-in after that point.
  let userStoppedOnce = false;
  const markStopped = () => {
    userStoppedOnce = true;
  };

  (async () => {
    try {
      let data = await fetchReadingMaybePolling(id, paidRedirect);

      // Bounce-recovery: user navigated to /okuma/:id while the
      // background generation is still running — e.g. they copied the
      // link from the loading-screen escape hatch, refreshed, or shared
      // the link. Mount the same mystical loading experience the form
      // flow uses (moon + constellations + phased text + escape hatch),
      // not a generic spinner — so the experience feels consistent
      // regardless of how they arrived at this page.
      if (data.status === "pending") {
        if (actionBar) actionBar.style.display = "none";
        kapakSozuEl.textContent = "";
        let loadingHandle = null;
        const finalData = await new Promise((resolve) => {
          loadingHandle = mountLoadingExperience(root, {
            readingId: id,
            isCancelled: () => cancelled,
            // hasEmail comes from the initial fetch — if the user (or
            // someone they shared the link with) already attached an
            // email, the escape hatch opens in its "confirmed" state
            // instead of asking again.
            hasEmail: Boolean(data.hasEmail),
            onDone: (final) => resolve(final),
            onError: (msg) => resolve({ status: "error", error: msg }),
          });
        });
        if (cancelled) return;
        if (finalData.status === "error") {
          if (loadingHandle) loadingHandle.cleanup();
          kapakSozuEl.textContent =
            finalData.error || "Yıldızlar bugün karanlık. Sonra tekrar dene.";
          return;
        }
        data = finalData;
        // Keep the loading overlay mounted while we render the result
        // content underneath, then tear it down so the reading is
        // revealed in one motion instead of flashing through "empty
        // result page".
        disposables.push(() => loadingHandle && loadingHandle.cleanup());
        if (actionBar) actionBar.style.display = "";
        // Defer the actual unmount to after the result content has been
        // populated below (kapakSozu, sections, etc.). Using a microtask
        // here gives the synchronous renders below a chance to run
        // first.
        Promise.resolve().then(() => {
          if (loadingHandle) loadingHandle.cleanup();
        });
      }
      if (data.status === "error") {
        kapakSozuEl.textContent =
          data.error || "Yıldızlar bugün karanlık. Sonra tekrar dene.";
        if (actionBar) actionBar.style.display = "none";
        return;
      }
      const isUnlocked = Boolean(data.unlocked || unlockedQuery === "true");

      // Clean up the ?paid=1 from the URL so refreshing the page doesn't
      // re-trigger the polling overlay. Use replaceState so it doesn't
      // create a back-button entry.
      if (paidRedirect) {
        try {
          window.history.replaceState(
            {},
            "",
            `/okuma/${encodeURIComponent(id)}`,
          );
        } catch {
          /* ignore */
        }
      }

      // ---------- GA4 funnel events ----------
      // Safe no-op off-prod: gtag is defined by the inline <head> snippet
      // on every page, but the remote tag only loads on prod (or with the
      // localStorage.ga4_debug opt-in on localhost). Off-prod, calls just
      // queue into dataLayer with no network egress.
      //
      // sessionStorage keys per-tab dedup re-mounts / re-fetches of the
      // same reading. Stripe + the polling-overlay flow already make
      // double-firing implausible, but the storage check is cheap insurance
      // and survives the in-app-browser quirks we worry about elsewhere.
      if (typeof window.gtag === "function") {
        try {
          // 1) reading_started — fires on ANY /okuma view (free OR paid),
          //    deduped per reading per tab. Decoupled from isUnlocked so
          //    the funnel always has an entry event for every converting
          //    user, even on edge cases: extensions that wipe
          //    sessionStorage between the free visit and the Stripe
          //    redirect; browsers that open Stripe in a new tab
          //    (sessionStorage is per-tab); init-load races where the
          //    first fire missed GA4 because the tag hadn't loaded. The
          //    sessionStorage dedup still keeps it to ONE per reading
          //    per tab session.
          const startKey = "ga4_reading_started_" + id;
          if (!sessionStorage.getItem(startKey)) {
            sessionStorage.setItem(startKey, "1");
            window.gtag("event", "reading_started");
          }
          // 2) report_unlocked — only on the actual Stripe redirect (the
          //    conversion moment). transaction_id = Stripe Checkout
          //    Session id (cs_...) for GA4 dedup. value = real amount
          //    the customer paid (post-discount, from
          //    session.amount_total via migration 0010 — accurate even
          //    when a promo was applied). coupon + discount are GA4's
          //    standard ecommerce parameters for promo attribution;
          //    register them as Custom Dimensions/Metrics in GA4 Admin
          //    so they show up in reports. Falls back gracefully for
          //    legacy paid rows where amountPaidTry defaults to 349.99
          //    on the server side.
          if (paidRedirect && data.stripeSessionId) {
            // Dedup key mirrors the event name on purpose ("report_unlocked")
            // so a future reader of sessionStorage can match keys to GA4
            // events at a glance.
            const unlockedKey = "ga4_report_unlocked_" + data.stripeSessionId;
            if (!sessionStorage.getItem(unlockedKey)) {
              sessionStorage.setItem(unlockedKey, "1");
              window.gtag("event", "report_unlocked", {
                currency: "TRY",
                value:
                  typeof data.amountPaidTry === "number"
                    ? data.amountPaidTry
                    : 349.99,
                transaction_id: data.stripeSessionId,
                coupon: data.promotionCode || undefined,
                discount:
                  typeof data.amountDiscountTry === "number"
                    ? data.amountDiscountTry
                    : 0,
              });
            }
          }
        } catch {
          /* analytics must never break the reading render */
        }
      }

      // Edge case: ?paid=1 but the webhook didn't fire within the poll
      // window. Replace the polling card with a polite "still processing"
      // message — user can refresh manually. Almost never happens in
      // practice; webhooks usually beat the 12-second poll window.
      if (paidRedirect && !isUnlocked) {
        if (pollingOverlay) {
          const card = pollingOverlay.querySelector(".post-payment-card");
          if (card) {
            card.innerHTML = `
              <p class="post-payment-success-title">Ödemen alındı — yıldıznamen birazdan açılır.</p>
              <p class="post-payment-success-body">Birkaç saniye sonra sayfayı yenilemen yeterli.</p>
              <button type="button" class="btn-gold-outline post-payment-refresh">Yenile</button>
            `;
            const refreshBtn = card.querySelector(".post-payment-refresh");
            if (refreshBtn) {
              refreshBtn.addEventListener("click", () => window.location.reload());
            }
          }
        }
        return;
      }

      // Happy paid-redirect path: morph the polling card into a
      // "Mühür kırıldı" success card with the invoice link (when the
      // webhook successfully fetched it from Stripe). User dismisses
      // the modal and the underlying unlocked reading is already
      // there. The post-actions row gets no permanent invoice button —
      // the modal IS the invoice handoff.
      if (paidRedirect && isUnlocked && pollingOverlay) {
        const card = pollingOverlay.querySelector(".post-payment-card");
        const tpl = document.getElementById("tpl-success-card");
        if (card && tpl) {
          card.replaceChildren(tpl.content.firstElementChild.cloneNode(true));
          const successCard = card.querySelector(".post-payment-success");
          const invoiceLink = successCard.querySelector(".post-payment-invoice");
          const dismissBtn = successCard.querySelector(".post-payment-dismiss");
          const invoiceUrl = data.invoiceHostedUrl || data.invoicePdfUrl;
          if (invoiceUrl) {
            invoiceLink.href = invoiceUrl;
            invoiceLink.hidden = false;
          }
          const closeOverlay = () => {
            pollingOverlay.classList.add("is-closing");
            window.setTimeout(() => {
              pollingOverlay?.remove();
              pollingOverlay = null;
            }, 400);
          };
          dismissBtn.addEventListener("click", closeOverlay);
        }
      } else if (pollingOverlay) {
        // Non-paid-redirect renders that somehow still have an overlay
        // (shouldn't happen but defensive). Just tear it down.
        pollingOverlay.remove();
        pollingOverlay = null;
      }

      kapakSozuEl.textContent = data.kapakSozu;

      sectionsHost.replaceChildren();

      const freeSection = makeSection({
        title: SECTION_TITLES.karakterinOzu,
        text: data.karakterinOzu,
        readingId: id,
        // sectionKey gates which (virtual) sections the per-section
        // player walks. In free state, /api/reading/:id has truncated
        // data.karakterinOzu to the preview, and the player plays the
        // chunks of just karakterinOzu (the preview audio variant
        // matches the preview text). Once unlocked, sectionKey expands
        // to [karakterinOzu, karakterinOzuRest] so chunks of preview
        // and rest play back-to-back as one continuous track — the
        // preview chunks are already in R2 cache from the free state,
        // so we only pay ElevenLabs for the new rest chunks.
        sectionKey: isUnlocked
          ? ["karakterinOzu", "karakterinOzuRest"]
          : "karakterinOzu",
        chunkCounts: data.chunkCounts,
        autoplay: journeyAutoplay && !userStoppedOnce,
        manuallyStopped: markStopped,
        // Counter only on the free-preview state — once unlocked the user
        // already has the full reading and the count is just noise.
        counter: isUnlocked
          ? null
          : "Yıldıznamenin ilk bölümü — dokuz mührü kapalı",
      });
      sectionsHost.appendChild(freeSection.node);
      disposables.push(freeSection.dispose);

      // Free state: append the inline literary-paywall — a blurred real
      // sentence + ellipsis + gold italic "Devamını oku →" link — to
      // the last visible <p> of the karakterinOzu section body. The link
      // is the third unlock entry point (sticky + top/bottom payment
      // blocks are the others) and is wired into the same modal — see
      // the .devamini-oku-inline entry in the click-handler loop below.
      // Replaces an earlier "big button + dot placeholder" treatment and
      // a section-scroll-hint pill, both retired because they read as
      // "section complete" rather than "section continues".
      if (!isUnlocked && data.karakterinOzuTeaser) {
        // Inline literary-paywall pattern: append the first sentence of
        // the locked rest as a blurred <span> directly inside the last
        // visible <p>, followed by an ellipsis and a gold italic
        // "Devamını oku →" link. The reader's eye flows from clear
        // preview prose → blurred real text → ellipsis → gold CTA, all
        // on the same paragraph line. No paragraph break, no horizontal
        // button — feels like the müneccim drops his voice into a hint
        // and points to "and there's more…". The link opens the same
        // reveal modal as the sticky CTA + payment blocks (wired below
        // via the `.devamini-oku-inline` selector).
        const lastP = freeSection.node.querySelector(
          ".section-body > p:last-child",
        );
        if (lastP) {
          // Leading space so the blur ribbon doesn't smash into the
          // preview's final period.
          lastP.appendChild(document.createTextNode(" "));

          const teaser = document.createElement("span");
          teaser.className = "rest-teaser-inline";
          teaser.setAttribute("aria-hidden", "true");
          teaser.textContent = data.karakterinOzuTeaser;
          lastP.appendChild(teaser);

          // Ellipsis in clear text bridges blurred prose to the gold
          // link, signalling "...there's more, click here".
          lastP.appendChild(document.createTextNode(" … "));

          const link = document.createElement("a");
          link.className = "devamini-oku-inline";
          link.setAttribute("role", "button");
          link.setAttribute("tabindex", "0");
          link.textContent = "Devamını oku →";
          lastP.appendChild(link);
        }
      }

      const orn = document.createElement("div");
      orn.className = "ornament";
      orn.textContent = "❧";
      orn.setAttribute("aria-hidden", "true");
      sectionsHost.appendChild(orn);

      // Lean CTA system: no top payment block, no top locked-actions
      // block. The inline "Devamını oku →" hook inside karakterinOzu
      // already catches the just-finished-reading moment; the single
      // unlock card at the bottom (after the 9 blurred sections) is the
      // primary conversion surface. One primary CTA per context.

      for (const key of LOCKED_SECTION_KEYS) {
        const text = data[key];
        if (isUnlocked && typeof text === "string" && text.length > 0) {
          const sec = makeSection({
            title: SECTION_TITLES[key],
            text,
            readingId: id,
            sectionKey: key,
            chunkCounts: data.chunkCounts,
            manuallyStopped: markStopped,
          });
          sectionsHost.appendChild(sec.node);
          disposables.push(sec.dispose);
        } else {
          const sec = makeSection({
            title: SECTION_TITLES[key],
            locked: true,
          });
          sectionsHost.appendChild(sec.node);
        }
      }

      // The single unlock card — primary conversion surface in free
      // state. Sits after the 9 blurred sections (the bottom of the
      // scroll). Title + price + feature-list + one gold-fill button.
      if (!isUnlocked) {
        sectionsHost.appendChild(makeUnlockCard());
      }

      // ----- Persistent action bar -----
      // The primary pill is dual-purpose: free → opens the unlock modal;
      // paid → the "Baştan Sona Dinle" chain play button. Secondary icons
      // (PDF / Paylaş / Yorum / Yeni) wire to their actions and show/hide
      // per state.
      const barPrimary = actionBar.querySelector(".action-bar-primary");
      const barPdf = actionBar.querySelector(".ab-pdf");
      const barShare = actionBar.querySelector(".ab-share");
      const barFeedback = actionBar.querySelector(".ab-feedback");
      const barNew = actionBar.querySelector(".ab-new");

      // Secondary icons present in BOTH states:
      barShare.addEventListener("click", () => handleShare(barShare));
      barNew.addEventListener("click", () => router.navigate("/"));

      if (!isUnlocked) {
        // Free: primary pill opens the unlock modal. PDF + Yorum hidden
        // (they're paid-only). Paylaş + Yeni stay (sharing the free
        // preview is a viral lever).
        barPrimary.textContent = "Kaderinin tamamını aç →";
        barPdf.hidden = true;
        barFeedback.hidden = true;
        const openUnlockModal = wireUnlockModal({ root, id, router, disposables });
        barPrimary.addEventListener("click", openUnlockModal);
      } else {
        // Paid: the primary pill IS the chain "Baştan Sona Dinle" button.
        const listenBtn = barPrimary;
        listenBtn.textContent = LISTEN_IDLE;
        barPdf.hidden = false;
        barPdf.addEventListener("click", () => window.print());

        // Feedback icon → modal, unless already rated (one-shot). On a
        // successful submit, retire the icon for this reading.
        if (!data.feedbackGiven) {
          barFeedback.hidden = false;
          const openFeedbackModal = wireFeedbackModal({
            root,
            id,
            disposables,
            onSubmitted: () => {
              barFeedback.hidden = true;
            },
          });
          barFeedback.addEventListener("click", openFeedbackModal);
          // Funnel: a paid user has the feedback affordance available.
          api.trackEvent(id, "viewed_feedback_cta");
        } else {
          barFeedback.hidden = true;
        }

        // Sequential playback: karakterinOzu (preview) → karakterinOzuRest
        // (remaining 2/3, no kapakSözü prepend) → the nine locked
        // sections. Flatten the section list × chunkCounts into a flat
        // queue of {section, chunkIdx} refs — each chunk is its own
        // small MP3 with a known Content-Length (mobile-safe). The
        // preview chunks are already in R2 cache from the free state,
        // so the chain only triggers fresh synth for the post-unlock
        // chunks. If a section happens to be empty (e.g. karakterinOzuRest
        // when text was too short to split), chunkCounts[section] is 0
        // and those refs simply don't appear in the queue — no
        // skip-on-404 needed.
        const sectionList = [
          "karakterinOzu",
          "karakterinOzuRest",
          ...LOCKED_SECTION_KEYS,
        ];
        const queue = [];
        for (const sec of sectionList) {
          const n = (data.chunkCounts && data.chunkCounts[sec]) || 0;
          for (let i = 0; i < n; i++) queue.push({ section: sec, chunkIdx: i });
        }
        let queueIdx = 0;
        let chainActive = false;

        // Chunk prefetch pipeline for the chain player. Mirrors the
        // per-section makeAudioPlayer prefetch: PREFETCH_AHEAD=2 keeps
        // total upstream concurrency at 3 (one audio element + two
        // background fetches), matching the ElevenLabs plan cap. Chain
        // playback is a much longer queue (up to 11 sections × N chunks
        // each) so the pipeline pays off even more here — without it
        // every "ended" event waited for a full Worker → R2 round-trip
        // before the next chunk started, giving the gappy experience
        // the chunking design was supposed to fix.
        const CHAIN_PREFETCH_AHEAD = 2;
        const chainPrefetched = new Set();
        let chainPrefetchAbort = null;
        const chainPrefetch = (pos) => {
          for (let i = 1; i <= CHAIN_PREFETCH_AHEAD; i += 1) {
            const targetPos = pos + i;
            if (targetPos >= queue.length) break;
            const ref = queue[targetPos];
            const url = api.ttsChunkUrl(id, ref.section, ref.chunkIdx);
            if (chainPrefetched.has(url)) continue;
            chainPrefetched.add(url);
            if (!chainPrefetchAbort) chainPrefetchAbort = new AbortController();
            fetch(url, { signal: chainPrefetchAbort.signal }).catch(() => {
              chainPrefetched.delete(url);
            });
          }
        };
        // Cancel any in-flight chain prefetches on cleanup — matches the
        // chainAudio disposable pushed earlier at the top of the IIFE.
        disposables.push(() => {
          if (chainPrefetchAbort) {
            chainPrefetchAbort.abort();
            chainPrefetchAbort = null;
          }
        });

        const onEndedAdvance = () => {
          if (!chainActive) return;
          queueIdx += 1;
          if (queueIdx >= queue.length) {
            chainActive = false;
            listenBtn.textContent = LISTEN_IDLE;
            return;
          }
          const ref = queue[queueIdx];
          chainAudio.src = api.ttsChunkUrl(id, ref.section, ref.chunkIdx);
          chainPrefetch(queueIdx);
          chainAudio.play().catch(() => {
            chainActive = false;
            listenBtn.textContent = LISTEN_IDLE;
          });
        };
        chainAudio.addEventListener("ended", onEndedAdvance);
        chainAudio.addEventListener("error", () => {
          // Mid-chain transient error (network blip, an isolated chunk
          // synth fail) after at least one chunk has played — skip to
          // the next chunk rather than hard-stopping. The user has
          // committed to the chain; tiny gap is better than full stop.
          if (chainActive && queueIdx > 0 && queueIdx + 1 < queue.length) {
            onEndedAdvance();
            return;
          }
          // First-chunk failure = real TTS pipeline issue — surface the
          // in-voice copy on the pill briefly, then revert.
          chainActive = false;
          listenBtn.textContent =
            "Müneccim'in sesi şu an gelmiyor. Birazdan tekrar dene.";
          listenBtn.disabled = true;
          window.setTimeout(() => {
            listenBtn.textContent = LISTEN_IDLE;
            listenBtn.disabled = false;
          }, 4000);
        });

        listenBtn.addEventListener("click", () => {
          if (chainActive) {
            chainActive = false;
            chainAudio.pause();
            listenBtn.textContent = LISTEN_IDLE;
            return;
          }
          if (queue.length === 0) return; // defensive: no chunks at all
          // Funnel: fire only on the start of a chain play, not pause/stop.
          api.trackEvent(id, "listened_chain");
          chainActive = true;
          queueIdx = 0;
          const ref = queue[0];
          chainAudio.src = api.ttsChunkUrl(id, ref.section, ref.chunkIdx);
          chainPrefetch(0);
          chainAudio.play().catch(() => {
            chainActive = false;
            listenBtn.textContent = LISTEN_IDLE;
          });
          listenBtn.textContent = LISTEN_PLAYING;
        });
      }

      // Reveal the bar ~1.5s after mount (don't slam over the autoplay),
      // then keep it visible. The result view has bottom padding so the
      // bar never permanently covers content.
      const barShowDelay = window.setTimeout(() => {
        actionBar.classList.add("is-visible");
        actionBar.setAttribute("aria-hidden", "false");
      }, 1500);
      disposables.push(() => window.clearTimeout(barShowDelay));
    } catch (err) {
      sectionsHost.replaceChildren();
      kapakSozuEl.textContent = "";
      const e = document.createElement("p");
      e.textContent = err.message || "Okuma yüklenemedi.";
      e.style.color = "var(--silver)";
      e.style.fontStyle = "italic";
      e.style.textAlign = "center";
      sectionsHost.appendChild(e);
      const back = document.createElement("a");
      back.href = "/";
      back.dataset.link = "true";
      back.className = "btn-gold-outline";
      back.textContent = "Başa dön";
      back.style.display = "block";
      back.style.margin = "1.5rem auto 0";
      back.style.maxWidth = "max-content";
      sectionsHost.appendChild(back);
    }
  })();

  return root;
}

// ----------------------------------------------------------------------------
// Error
// ----------------------------------------------------------------------------

export function renderError(message) {
  const root = tpl("tpl-error");
  root.querySelector(".err-msg").textContent =
    message ?? "Aradığın sayfa yıldız haritasında yok.";
  return root;
}
