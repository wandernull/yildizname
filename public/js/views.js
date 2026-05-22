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

const LOADING_MESSAGES = [
  "Müneccim harflerini okuyor…",
  "Ay burçta hizalanıyor…",
  "Ebced hesabı tamamlanıyor…",
  "Kader yazılıyor…",
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

export function renderLanding() {
  return tpl("tpl-landing");
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
    navBack.disabled = step === 0;
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
    router.navigate("/loading");
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
// cycling messages and the constellation animation keep the surface alive
// while we wait.
const MIN_LOADING_MS = 2500;

export function renderLoading(router) {
  const root = tpl("tpl-loading");
  const msgEl = root.querySelector(".loading-msg");

  let idx = 0;
  let cancelled = false;
  let navTimer = 0;

  const cycle = window.setInterval(() => {
    idx = (idx + 1) % LOADING_MESSAGES.length;
    msgEl.style.opacity = "0";
    setTimeout(() => {
      if (cancelled) return;
      msgEl.textContent = LOADING_MESSAGES[idx];
      msgEl.style.opacity = "1";
    }, 250);
  }, 1600);

  const cleanup = () => {
    cancelled = true;
    window.clearInterval(cycle);
    if (navTimer) window.clearTimeout(navTimer);
  };
  root.addEventListener("view:cleanup", cleanup);

  const showError = (message) => {
    cleanup();
    msgEl.textContent = message || "Yıldızlar şu an okunamıyor.";
    msgEl.style.opacity = "1";
    msgEl.classList.remove("shimmer-gold");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-gold-outline";
    btn.style.marginTop = "2rem";
    btn.textContent = "Tekrar dene";
    btn.addEventListener("click", () =>
      router.navigate("/form", { replace: true }),
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
      router.navigate("/form", { replace: true });
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
        router.navigate(`/result/${encodeURIComponent(data.id)}`, {
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
}) {
  const section = document.createElement("section");
  section.className = "section" + (locked ? " locked" : "");

  const h3 = document.createElement("h3");
  h3.textContent = title;
  section.appendChild(h3);

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
  section.appendChild(player.wrap);
  return { node: section, dispose: player.dispose };
}

function makePaymentBlock(id, router) {
  const wrap = document.createElement("div");
  wrap.className = "payment-block";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-gold-fill";
  btn.textContent = "Kaderinin tamamını aç — 250 ₺";
  const note = document.createElement("p");
  note.className = "payment-note";
  note.textContent = "Güvenli ödeme · Stripe";
  const err = document.createElement("p");
  err.className = "payment-error";
  err.hidden = true;
  wrap.append(btn, note, err);

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Kapı aralanıyor…";
    err.hidden = true;
    try {
      const res = await api.unlockReading(id);
      if (!res.success) throw new Error(res.error ?? "Ödeme başarısız.");
      router.navigate(`/result/${encodeURIComponent(id)}?unlocked=true`, { replace: true });
    } catch (e) {
      err.textContent = e.message || "Bilinmeyen hata.";
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = "Kaderinin tamamını aç — 250 ₺";
    }
  });

  return wrap;
}

export function renderResult(router, { id, unlockedQuery }) {
  const root = tpl("tpl-result");
  const kapakSozuEl = root.querySelector(".kapak-sozu");
  const sectionsHost = root.querySelector(".sections-host");
  const postActions = root.querySelector(".post-actions");

  // initial placeholder while we fetch
  kapakSozuEl.textContent = "Okuma açılıyor…";

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
      const data = await api.fetchReading(id);
      const isUnlocked = Boolean(data.unlocked || unlockedQuery === "true");
      kapakSozuEl.textContent = data.kapakSozu;

      sectionsHost.replaceChildren();

      const freeSection = makeSection({
        title: SECTION_TITLES.karakterinOzu,
        text: data.karakterinOzu,
        readingId: id,
        sectionKey: "karakterinOzu",
        autoplay: journeyAutoplay && !userStoppedOnce,
        manuallyStopped: markStopped,
      });
      sectionsHost.appendChild(freeSection.node);
      disposables.push(freeSection.dispose);

      const orn = document.createElement("div");
      orn.className = "ornament";
      orn.textContent = "❧";
      orn.setAttribute("aria-hidden", "true");
      sectionsHost.appendChild(orn);

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
        sectionsHost.appendChild(makePaymentBlock(id, router));
      } else {
        postActions.hidden = false;
        const listenBtn = postActions.querySelector(".action-listen-all");
        const printBtn = postActions.querySelector(".action-print");

        // Sequential playback through all 11 sections using the single
        // chainAudio element. Cache hits make this near-seamless; cache
        // misses incur a per-section synthesis delay.
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
