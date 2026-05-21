// View renderers. Each render* function returns the populated DOM node
// for a `<template>` defined in /index.html. The router clones the
// template, calls the renderer to wire up listeners, and mounts it.

import { LOCKED_SECTION_KEYS, SECTION_TITLES } from "./sections.js";
import * as api from "./api.js";
import * as tts from "./tts.js";

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

export function renderLoading(router) {
  const root = tpl("tpl-loading");
  const msgEl = root.querySelector(".loading-msg");

  let idx = 0;
  const cycle = window.setInterval(() => {
    idx = (idx + 1) % LOADING_MESSAGES.length;
    msgEl.style.opacity = "0";
    setTimeout(() => {
      msgEl.textContent = LOADING_MESSAGES[idx];
      msgEl.style.opacity = "1";
    }, 250);
  }, 1600);

  const cleanup = () => window.clearInterval(cycle);
  root.addEventListener("view:cleanup", cleanup);

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
    const MIN_DURATION = 3000;
    try {
      const data = await api.generateReading(form);
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, MIN_DURATION - elapsed);
      setTimeout(() => {
        try {
          window.sessionStorage.removeItem(FORM_SESSION_KEY);
        } catch {
          /* ignore */
        }
        router.navigate(`/result/${encodeURIComponent(data.id)}`, { replace: true });
      }, wait);
    } catch (err) {
      cleanup();
      msgEl.textContent = err.message || "Yıldızlar şu an okunamıyor.";
      msgEl.style.opacity = "1";
      msgEl.classList.remove("shimmer-gold");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-gold-outline";
      btn.style.marginTop = "2rem";
      btn.textContent = "Tekrar dene";
      btn.addEventListener("click", () => router.navigate("/form", { replace: true }));
      root.appendChild(btn);
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
  // Split into paragraphs by blank lines, then into sentence spans for highlight.
  return text
    .split(/\n+/)
    .map((p) => {
      const sentences = p.split(/(?<=[.!?…])\s+/);
      const spans = sentences
        .map((s) => `<span class="sentence">${escapeHtml(s)} </span>`)
        .join("");
      return `<p>${spans}</p>`;
    })
    .join("");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function makeAudioPlayer(text, sectionBodyEl) {
  const wrap = document.createElement("div");
  wrap.className = "audio-player";

  if (!tts.isSupported()) {
    wrap.innerHTML = `<p class="audio-label">Sesli okuma tarayıcınızda desteklenmiyor.</p>`;
    return wrap;
  }

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "audio-btn play";
  playBtn.setAttribute("aria-label", "Dinle");
  playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M2 1 L13 7 L2 13 Z"/></svg>`;

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

  let playing = false;
  let paused = false;

  const setIcon = (icon) => {
    playBtn.innerHTML =
      icon === "pause"
        ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="3" height="12"/><rect x="9" y="1" width="3" height="12"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M2 1 L13 7 L2 13 Z"/></svg>`;
  };

  const highlight = (charIndex) => {
    if (!sectionBodyEl) return;
    const spans = sectionBodyEl.querySelectorAll(".sentence");
    if (charIndex < 0) {
      spans.forEach((s) => s.classList.remove("active"));
      return;
    }
    let cursor = 0;
    for (const span of spans) {
      const len = span.textContent.length;
      const isActive = charIndex >= cursor && charIndex < cursor + len;
      span.classList.toggle("active", isActive);
      cursor += len;
    }
  };

  playBtn.addEventListener("click", () => {
    if (playing) {
      tts.pause();
      paused = true;
      playing = false;
      label.textContent = "Duraklatıldı";
      setIcon("play");
      waveform.classList.remove("active");
      return;
    }
    if (paused) {
      tts.resume();
      paused = false;
      playing = true;
      label.textContent = "Müneccim okuyor…";
      setIcon("pause");
      waveform.classList.add("active");
      return;
    }
    tts.speak({
      text,
      onBoundary: highlight,
      onEnd: () => {
        playing = false;
        paused = false;
        label.textContent = "Sesli dinle";
        setIcon("play");
        waveform.classList.remove("active");
        stopBtn.disabled = true;
        highlight(-1);
      },
      onError: () => {
        playing = false;
        paused = false;
        label.textContent = "Sesli dinle";
        setIcon("play");
        waveform.classList.remove("active");
        stopBtn.disabled = true;
      },
    });
    playing = true;
    paused = false;
    label.textContent = "Müneccim okuyor…";
    setIcon("pause");
    waveform.classList.add("active");
    stopBtn.disabled = false;
  });

  stopBtn.addEventListener("click", () => {
    tts.stop();
    playing = false;
    paused = false;
    label.textContent = "Sesli dinle";
    setIcon("play");
    waveform.classList.remove("active");
    stopBtn.disabled = true;
    highlight(-1);
  });

  return wrap;
}

function makeSection(title, text, opts = {}) {
  const section = document.createElement("section");
  section.className = "section" + (opts.locked ? " locked" : "");

  const h3 = document.createElement("h3");
  h3.textContent = title;
  section.appendChild(h3);

  const body = document.createElement("div");
  body.className = "section-body";

  if (opts.locked) {
    body.innerHTML = `
      <p>················································ ······· ···········</p>
      <p>·········· ·············· ······ ·············· ······· ··········</p>
      <p>········· ······ ········· ········ ··········· ···············</p>
    `;
  } else {
    body.innerHTML = paragraphHtml(text);
  }
  section.appendChild(body);

  if (opts.locked) {
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
  } else {
    section.appendChild(makeAudioPlayer(text, body));
  }
  return section;
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

  const cleanup = () => tts.stop();
  root.addEventListener("view:cleanup", cleanup);

  (async () => {
    try {
      const data = await api.fetchReading(id);
      const isUnlocked = Boolean(data.unlocked || unlockedQuery === "true");
      kapakSozuEl.textContent = data.kapakSozu;

      sectionsHost.replaceChildren();
      sectionsHost.appendChild(
        makeSection(SECTION_TITLES.karakterinOzu, data.karakterinOzu),
      );

      const orn = document.createElement("div");
      orn.className = "ornament";
      orn.textContent = "❧";
      orn.setAttribute("aria-hidden", "true");
      sectionsHost.appendChild(orn);

      for (const key of LOCKED_SECTION_KEYS) {
        const text = data[key];
        if (isUnlocked && typeof text === "string" && text.length > 0) {
          sectionsHost.appendChild(makeSection(SECTION_TITLES[key], text));
        } else {
          sectionsHost.appendChild(
            makeSection(SECTION_TITLES[key], "", { locked: true }),
          );
        }
      }

      if (!isUnlocked) {
        sectionsHost.appendChild(makePaymentBlock(id, router));
      } else {
        postActions.hidden = false;
        const listenBtn = postActions.querySelector(".action-listen-all");
        const printBtn = postActions.querySelector(".action-print");

        let chainPlaying = false;
        listenBtn.addEventListener("click", () => {
          if (chainPlaying) {
            tts.stop();
            chainPlaying = false;
            listenBtn.textContent = "Baştan Sona Dinle";
            return;
          }
          const allText = [
            data.karakterinOzu,
            ...LOCKED_SECTION_KEYS.map((k) => data[k]).filter(
              (t) => typeof t === "string" && t.length > 0,
            ),
          ].join("\n\n");
          tts.speak({
            text: allText,
            onEnd: () => {
              chainPlaying = false;
              listenBtn.textContent = "Baştan Sona Dinle";
            },
            onError: () => {
              chainPlaying = false;
              listenBtn.textContent = "Baştan Sona Dinle";
            },
          });
          chainPlaying = true;
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
