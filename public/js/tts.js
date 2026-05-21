// Web Speech API wrapper, tr-TR voice, slowed pace.

export function isSupported() {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window
  );
}

function pickTurkishVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang === "tr-TR") ??
    voices.find((v) => v.lang.startsWith("tr"))
  );
}

export function speak({ text, onBoundary, onEnd, onError, rate = 0.85, pitch = 0.9 }) {
  if (!isSupported()) return null;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "tr-TR";
  u.rate = rate;
  u.pitch = pitch;
  const voice = pickTurkishVoice();
  if (voice) u.voice = voice;
  if (onBoundary) {
    u.onboundary = (ev) => onBoundary(ev.charIndex, ev.charLength ?? 0);
  }
  if (onEnd) u.onend = () => onEnd();
  if (onError) u.onerror = (ev) => onError(ev);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  return u;
}

export function pause() {
  if (isSupported()) window.speechSynthesis.pause();
}

export function resume() {
  if (isSupported()) window.speechSynthesis.resume();
}

export function stop() {
  if (isSupported()) window.speechSynthesis.cancel();
}
