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

export function renderLoading(router) {
  const root = tpl("tpl-loading");
  const primaryEl = root.querySelector(".loading-primary");
  const secondaryEl = root.querySelector(".loading-secondary");
  const constellationHost = root.querySelector(".constellation-host");
  const harflerHost = root.querySelector(".harfler-host");

  let cancelled = false;
  let navTimer = 0;
  const startedAt = Date.now();

  // Start everything that isn't text rotation immediately — the moon
  // animation is pure CSS, the constellation parade and harfler each
  // self-schedule.
  const stopConstellations = startConstellationParade(constellationHost);
  const stopHarfler = startHarfler(harflerHost);

  // Phased text. Initial render is immediate (no fade); subsequent rotations
  // fade out → swap → fade in. Each phase has 3 primary + 3 secondary lines
  // that cycle within the phase every ~4.5s.
  let phaseIdx = 0;
  let lineIdx = 0;
  const swap = (el, text) => {
    el.style.opacity = "0";
    window.setTimeout(() => {
      if (cancelled) return;
      el.textContent = text;
      el.style.opacity = "1";
    }, 280);
  };
  const rotate = () => {
    if (cancelled) return;
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
  // Render phase 0 / line 0 immediately, no fade.
  primaryEl.textContent = LOADING_PHASES[0].primary[0];
  secondaryEl.textContent = LOADING_PHASES[0].secondary[0];
  primaryEl.style.opacity = "1";
  secondaryEl.style.opacity = "1";
  const textTimer = window.setInterval(rotate, 4500);

  const cleanup = () => {
    cancelled = true;
    window.clearInterval(textTimer);
    if (navTimer) window.clearTimeout(navTimer);
    stopConstellations();
    stopHarfler();
  };
  root.addEventListener("view:cleanup", cleanup);

  const showError = (message) => {
    cleanup();
    primaryEl.textContent = message || "Yıldızlar şu an okunamıyor.";
    primaryEl.style.opacity = "1";
    primaryEl.classList.remove("shimmer-gold");
    secondaryEl.textContent = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-gold-outline";
    btn.style.marginTop = "2rem";
    btn.textContent = "Tekrar dene";
    btn.addEventListener("click", () =>
      router.setStep("form"),
    );
    root.appendChild(btn);
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
    const startedAt = Date.now();
    try {
      const data = await api.generateReading(form);
      if (cancelled) return;
      if (!data.id) throw new Error(data.error || "Müneccim sustu.");
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, MIN_LOADING_MS - elapsed);
      navTimer = window.setTimeout(() => {
        if (cancelled) return;
        try {
          window.sessionStorage.removeItem(FORM_SESSION_KEY);
          // Mark the upcoming /result render as "user came through the
          // ritual" so it can autoplay karakterinOzu.
          window.sessionStorage.setItem(JOURNEY_FLAG, "1");
        } catch {
          /* ignore */
        }
        router.navigate(`/okuma/${encodeURIComponent(data.id)}`, {
          replace: true,
        });
      }, wait);
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
function makeAudioPlayer({ readingId, sectionKey, autoplay = false, manuallyStopped }) {
  const wrap = document.createElement("div");
  wrap.className = "audio-player";

  const audio = new Audio();
  audio.preload = autoplay ? "auto" : "none";
  audio.src = api.ttsUrl(readingId, sectionKey);

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
  audio.addEventListener("playing", setUiPlaying);
  audio.addEventListener("pause", () => {
    if (!audio.ended) setUiPaused();
  });
  audio.addEventListener("ended", () => setUiIdle());
  audio.addEventListener("error", () => {
    playBtn.classList.remove("loading", "pulse");
    setUiIdle("Ses gelmedi. Tekrar dener misin?");
  });

  playBtn.addEventListener("click", () => {
    playBtn.classList.remove("pulse");
    if (audio.paused) {
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
    autoplay,
    manuallyStopped,
  });
  // Insert the audio player between the title and the body so the user can
  // tap Dinle before reading, and the read+listen experience starts in sync.
  section.insertBefore(player.wrap, body);
  return { node: section, dispose: player.dispose };
}

// Lock glyph used inside disabled action buttons. Inline SVG so it inherits
// the button's currentColor.
const LOCK_GLYPH_HTML = `<span class="lock-glyph" aria-hidden="true"><svg viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6 V4 a3 3 0 0 1 6 0 v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="2" y="6" width="8" height="7" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="6" cy="9.5" r="0.7" fill="currentColor"/></svg></span>`;

// Apply the locked visual state (disabled buttons + lock glyph + native
// hover tooltip) to a `.post-actions` element. The lock SVG inside each
// button is signal enough on its own; the previous "Tam okumayla açılır"
// caption was felt to be over-explaining.
function applyLockedActionsState(postActionsEl) {
  const buttons = postActionsEl.querySelectorAll(
    ".action-listen-all, .action-print",
  );
  for (const btn of buttons) {
    btn.disabled = true;
    btn.classList.add("is-locked");
    if (!btn.querySelector(".lock-glyph")) {
      btn.insertAdjacentHTML("afterbegin", LOCK_GLYPH_HTML);
    }
    btn.title = "Tam okumayla açılır";
  }
}

// Build a fresh post-actions DOM node in the locked state. Same structure
// and styling as the template's bottom post-actions, just constructed
// programmatically so we can insert one near the top payment block too.
function makeLockedActionsBlock() {
  const wrap = document.createElement("div");
  wrap.className = "post-actions";

  const row = document.createElement("div");
  row.className = "post-actions-row";

  const listen = document.createElement("button");
  listen.type = "button";
  listen.className = "btn-gold-outline action-listen-all";
  listen.textContent = "Baştan Sona Dinle";

  const printer = document.createElement("button");
  printer.type = "button";
  printer.className = "btn-gold-outline action-print";
  printer.textContent = "PDF İndir";

  // Share button — always enabled, even on the locked preview. Sharing the
  // free preview to a friend drives organic conversion; the recipient sees
  // the same karakterinOzu and the same unlock CTA.
  const share = document.createElement("button");
  share.type = "button";
  share.className = "btn-gold-outline action-share";
  share.textContent = "Paylaş";

  row.append(listen, printer, share);
  wrap.append(row);
  // applyLockedActionsState only targets .action-listen-all + .action-print,
  // so .action-share is left active.
  applyLockedActionsState(wrap);
  return wrap;
}

// Native share sheet on touch-primary devices (mobile), clipboard copy on
// everything else. Why not navigator.share everywhere it exists? — macOS
// Safari ships navigator.share but its share sheet has no "Copy" option
// (Apple's deliberate choice, ~5y-old complaint, unlikely to change). On
// desktop the user almost certainly wants Copy as the primary action, so we
// skip the native sheet there. matchMedia('(hover: none) and (pointer:
// coarse)') is the standard CSS-level "this is a touch device" probe.
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

  try {
    if (isTouchPrimary && navigator.share) {
      // Mobile: native share sheet (iOS Safari includes Copy here;
      // Android's share sheet is rich with messaging apps).
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

// Shared unlock flow. Used by makePaymentBlock (inline gold-fill buttons)
// AND the sticky-CTA reveal modal. Calls /api/unlock which now returns a
// Stripe Checkout URL; the browser is redirected there. On Stripe success,
// the redirect lands back on /okuma/:id?paid=1&session=... where
// renderResult's post-payment polling handles the wait for the webhook.
//
// Idempotent on already-paid readings: server returns { alreadyUnlocked:
// true } in which case we just refresh the page so the unlocked state
// renders.
async function performUnlock(id, router, btn, errEl, restoreLabel) {
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

// Wires the sticky-bottom-CTA and reveal-modal that live in the result
// template. Only called when !isUnlocked. Manages visibility via two
// IntersectionObservers (sticky shows when karakterinOzu leaves viewport
// top, hides when the bottom payment block enters viewport) and routes
// modal-CTA clicks through the same performUnlock helper as the inline
// payment buttons.
function wireStickyAndModal({ root, id, router, sectionsHost, disposables }) {
  const sticky = root.querySelector(".sticky-cta");
  const stickyTrigger = root.querySelector(".sticky-cta-trigger");
  const modal = root.querySelector(".unlock-modal");
  const modalCta = root.querySelector(".unlock-modal-cta");
  const modalClose = root.querySelector(".unlock-modal-close");
  const modalError = root.querySelector(".unlock-modal-error");
  if (!sticky || !modal || !modalCta) return;

  // Visibility logic: sticky fades in 1.5s after the view mounts (just
  // enough delay so the autoplay starts cleanly without the sticky
  // sliding in over it), then stays visible until the bottom inline
  // payment block scrolls into the viewport. The previous version waited
  // for karakterinOzu to scroll out — too late, by then the user had
  // already finished the free section without seeing the unlock signal.
  const paymentBlocks = sectionsHost.querySelectorAll(".payment-block");
  const bottomPayment = paymentBlocks[paymentBlocks.length - 1] ?? null;

  let mountedShown = false;
  let bottomVisible = false;
  const refresh = () => {
    sticky.classList.toggle("is-visible", mountedShown && !bottomVisible);
  };

  const showDelay = window.setTimeout(() => {
    mountedShown = true;
    refresh();
  }, 1500);

  const bottomObs = new IntersectionObserver(
    (entries) => {
      bottomVisible = entries[0].isIntersecting;
      refresh();
    },
    { rootMargin: "0px 0px -80px 0px" },
  );
  if (bottomPayment) bottomObs.observe(bottomPayment);

  disposables.push(() => {
    window.clearTimeout(showDelay);
    bottomObs.disconnect();
  });

  // Single function that opens the modal in a clean state — resets any
  // error/loading from a previous attempt so the user sees the reveal
  // afresh every time.
  const openModal = () => {
    if (modalError) modalError.hidden = true;
    modalCta.disabled = false;
    modalCta.textContent = PAYMENT_CTA_LABEL;
    modal.showModal();
  };

  // ALL three CTA entry points open the same modal:
  //   - the sticky bar on mobile
  //   - the top inline payment block (after karakterinOzu)
  //   - the bottom inline payment block (after the locked sections)
  // The modal is the single place that performs the actual unlock and
  // displays the price — keeps the disclosure consistent regardless of
  // which CTA the user taps.
  stickyTrigger.addEventListener("click", openModal);
  for (const btn of root.querySelectorAll(".payment-block .btn-gold-fill")) {
    btn.addEventListener("click", openModal);
  }

  // Modal close affordances: × button, backdrop click, native ESC handler.
  modalClose.addEventListener("click", () => modal.close());
  modal.addEventListener("click", (ev) => {
    // Clicking the backdrop (the <dialog> itself, not its inner content)
    // closes the modal — native <dialog> doesn't do this out of the box.
    if (ev.target === modal) modal.close();
  });

  // Modal CTA → actual unlock. Single source of truth for the action.
  modalCta.addEventListener("click", () => {
    performUnlock(id, router, modalCta, modalError, PAYMENT_CTA_LABEL);
  });

  disposables.push(() => {
    if (modal.open) modal.close();
  });
}

function makePaymentBlock() {
  const wrap = document.createElement("div");
  wrap.className = "payment-block";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-gold-fill";
  btn.textContent = PAYMENT_CTA_LABEL;
  wrap.append(btn);
  // No click handler here — wireStickyAndModal attaches one that opens
  // the reveal modal. The modal's own CTA is what eventually calls
  // performUnlock. Single source of truth for the unlock action.
  return wrap;
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
  const postActions = root.querySelector(".post-actions");

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

  // Track every disposable (per-section audio + the chain-play audio) so we
  // can stop them all if the user navigates away.
  const disposables = [];
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
      const data = await fetchReadingMaybePolling(id, paidRedirect);
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
        sectionKey: "karakterinOzu",
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

      // Inline scroll-hint pill right after karakterinOzu, before the
      // ornament — catches the user at the natural "I just finished
      // reading" moment and points to what's below. Same locked-only
      // condition as the counter above.
      if (!isUnlocked) {
        const hint = document.createElement("p");
        hint.className = "section-scroll-hint";
        hint.textContent = "↓ Dokuz bölüm daha kilitli — mührünü kırınca açılır";
        sectionsHost.appendChild(hint);
      }

      const orn = document.createElement("div");
      orn.className = "ornament";
      orn.textContent = "❧";
      orn.setAttribute("aria-hidden", "true");
      sectionsHost.appendChild(orn);

      // Top payment block — same component used at the bottom. Sits right
      // before the locked sections so the user sees the unlock CTA the
      // moment they finish reading karakterinOzu, without scrolling past
      // 9 blurred placeholders to find it. Followed by an identical
      // locked-actions block (disabled "Baştan Sona Dinle" + "PDF İndir"
      // with "Tam okumayla açılır" hint) so the top placement mirrors the
      // bottom exactly.
      if (!isUnlocked) {
        sectionsHost.appendChild(makePaymentBlock());
        sectionsHost.appendChild(makeLockedActionsBlock());
      }

      for (const key of LOCKED_SECTION_KEYS) {
        const text = data[key];
        if (isUnlocked && typeof text === "string" && text.length > 0) {
          const sec = makeSection({
            title: SECTION_TITLES[key],
            text,
            readingId: id,
            sectionKey: key,
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

      if (!isUnlocked) {
        sectionsHost.appendChild(makePaymentBlock());
      }

      // The post-action buttons are visible at the bottom of the result
      // page even before unlock — disabled with a lock glyph inside each.
      // After unlock they light up and become functional. The same
      // locked-state block (built fresh by makeLockedActionsBlock above)
      // is also inserted at the top of the locked area so both placements
      // mirror exactly.
      const listenBtn = postActions.querySelector(".action-listen-all");
      const printBtn = postActions.querySelector(".action-print");

      if (!isUnlocked) {
        applyLockedActionsState(postActions);
      } else {

        // Sequential playback through all 11 sections using the single
        // chainAudio element. Cache hits make this near-seamless; cache
        // misses incur a per-section synthesis delay.
        // (handled below, after share-button wiring)
        const queue = ["karakterinOzu", ...LOCKED_SECTION_KEYS];
        let queueIdx = 0;
        let chainActive = false;

        const onEndedAdvance = () => {
          if (!chainActive) return;
          queueIdx += 1;
          if (queueIdx >= queue.length) {
            chainActive = false;
            listenBtn.textContent = "Baştan Sona Dinle";
            return;
          }
          chainAudio.src = api.ttsUrl(id, queue[queueIdx]);
          chainAudio.play().catch(() => {
            chainActive = false;
            listenBtn.textContent = "Baştan Sona Dinle";
          });
        };
        chainAudio.addEventListener("ended", onEndedAdvance);
        chainAudio.addEventListener("error", () => {
          chainActive = false;
          listenBtn.textContent = "Baştan Sona Dinle";
        });

        listenBtn.addEventListener("click", () => {
          if (chainActive) {
            chainActive = false;
            chainAudio.pause();
            listenBtn.textContent = "Baştan Sona Dinle";
            return;
          }
          chainActive = true;
          queueIdx = 0;
          chainAudio.src = api.ttsUrl(id, queue[queueIdx]);
          chainAudio.play().catch(() => {
            chainActive = false;
            listenBtn.textContent = "Baştan Sona Dinle";
          });
          listenBtn.textContent = "Sesi Durdur";
        });

        printBtn.addEventListener("click", () => window.print());
      }

      // Wire every share button on the page (both the JS-built top
      // locked-actions block and the template's bottom one). Share works
      // regardless of unlock state — the locked preview is itself a hook
      // for the recipient.
      for (const btn of root.querySelectorAll(".action-share")) {
        btn.addEventListener("click", () => handleShare(btn));
      }

      // Sticky CTA + reveal modal. Only when not unlocked. The sticky is
      // mobile-only via CSS @media; the JS just manages visibility based
      // on scroll position (show after karakterinOzu scrolls out, hide
      // when the bottom payment block scrolls in).
      if (!isUnlocked) {
        wireStickyAndModal({ root, id, router, sectionsHost, disposables });
      }
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
