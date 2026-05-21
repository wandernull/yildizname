// Background animations: twinkle star field + occasional shooting star.
// Each takes ownership of its own DOM element and runs as long as the
// page is open. Both pause their RAF / setTimeout when document.hidden
// is true to save battery on mobile.

const STAR_COUNT = 200;

export function initStarfield(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let stars = [];
  let raf = 0;
  let w = 0;
  let h = 0;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: STAR_COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.5 + Math.random() * 1.5,
      speed: 0.0006 + Math.random() * 0.0018,
      phase: Math.random() * Math.PI * 2,
      hue: Math.random() < 0.85 ? 0 : 1,
    }));
  };

  const draw = (t) => {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const tw =
        0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle =
        s.hue === 0
          ? `rgba(240, 244, 255, ${tw})`
          : `rgba(232, 238, 255, ${tw * 0.85})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(draw);
  };

  resize();
  raf = requestAnimationFrame(draw);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else {
      raf = requestAnimationFrame(draw);
    }
  });
}

export function initShootingStars(host) {
  let timer = 0;

  const fire = () => {
    const startX = Math.random() * window.innerWidth * 0.4;
    const startY = Math.random() * window.innerHeight * 0.3;
    const endX = startX + 300 + Math.random() * 400;
    const endY = startY + 200 + Math.random() * 300;

    const el = document.createElement("div");
    el.className = "shooting-star";
    el.style.left = startX + "px";
    el.style.top = startY + "px";
    host.appendChild(el);

    el.animate(
      [
        { transform: "rotate(35deg) translate(0, 0) scaleX(0)", opacity: 0 },
        { transform: "rotate(35deg) translate(20px, 14px) scaleX(1)", opacity: 1, offset: 0.3 },
        { transform: `rotate(35deg) translate(${endX - startX}px, ${endY - startY}px) scaleX(0.6)`, opacity: 0 },
      ],
      { duration: 700, easing: "ease-out", fill: "forwards" },
    ).onfinish = () => el.remove();
  };

  const scheduleNext = () => {
    const delay = 6000 + Math.random() * 6000;
    timer = window.setTimeout(() => {
      if (!document.hidden) fire();
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}
