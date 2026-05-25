// Entry point: initialise the background animations, set up History API
// routing, and render the right view for the current URL.
//
// URL model (Turkish, single-URL journey):
//   /                  → landing OR form OR loading, dispatched by an
//                        in-memory "journey step" — the URL bar stays stable
//                        through the entire ritual. Refresh resets to
//                        landing.
//   /okuma/:id         → result page (the first and only real URL the user
//                        lands on after the journey completes).
//
// Legacy paths from the previous version (`/form`, `/loading`, `/result/:id`)
// are redirected to the new shape so old shared links don't break.

import { initShootingStars, initStarfield } from "./bg.js";
import {
  renderError,
  renderForm,
  renderLanding,
  renderLoading,
  renderResult,
} from "./views.js";

const appRoot = document.getElementById("app");
const starCanvas = document.getElementById("starfield");
const shootingHost = document.getElementById("shooting-star-host");

initStarfield(starCanvas);
initShootingStars(shootingHost);

// Internal journey sub-step when the URL is `/`. Held in memory only so the
// URL bar doesn't twitch during the ritual. Refresh resets to landing.
const VALID_STEPS = new Set(["landing", "form", "loading"]);
let journeyStep = null;

function setTitle(state) {
  switch (state) {
    case "landing":
      document.title = "Yıldızname — Yıldızların altında, harflerin diliyle";
      break;
    case "form":
      document.title = "Yıldızname — Sorular";
      break;
    case "loading":
      document.title = "Yıldızname — Müneccim okuyor…";
      break;
    case "result":
      document.title = "Yıldızname — Yıldıznamen";
      break;
    default:
      document.title = "Yıldızname";
  }
}

// ----- router ---------------------------------------------------------------

const router = {
  // Real URL navigation (push or replace into History API).
  navigate(path, opts = {}) {
    const replace = !!opts.replace;
    if (replace) {
      window.history.replaceState({}, "", path);
    } else {
      window.history.pushState({}, "", path);
    }
    // Leaving the journey resets the in-memory step so a future return to "/"
    // starts at landing instead of resuming the last sub-view.
    journeyStep = null;
    render(window.location.pathname + window.location.search);
  },
  // Sub-view switch while staying at "/". No History API push — URL bar
  // doesn't move. Used for landing → form → loading transitions.
  setStep(step) {
    if (!VALID_STEPS.has(step)) return;
    journeyStep = step;
    render(window.location.pathname + window.location.search);
  },
};

function render(fullPath) {
  // Cleanup any view-local resources before swapping.
  const old = appRoot.firstElementChild;
  if (old) {
    old.dispatchEvent(new Event("view:cleanup"));
  }

  const [pathname, search = ""] = fullPath.split("?");
  const searchParams = new URLSearchParams(search);

  // Legacy-path migration: old shareable URLs from the previous routing
  // shape get rewritten in place to the new shape so we don't 404 them.
  if (pathname === "/form" || pathname === "/loading") {
    window.history.replaceState({}, "", "/");
    render("/");
    return;
  }
  if (pathname.startsWith("/result/")) {
    const rest = pathname.slice("/result/".length);
    const target = "/okuma/" + rest + (search ? "?" + search : "");
    window.history.replaceState({}, "", target);
    render(target);
    return;
  }

  let node;
  if (pathname === "/" || pathname === "") {
    const step = journeyStep || "landing";
    journeyStep = step;
    if (step === "loading") {
      node = renderLoading(router);
      setTitle("loading");
    } else if (step === "form") {
      node = renderForm(router);
      setTitle("form");
    } else {
      node = renderLanding(router);
      setTitle("landing");
    }
  } else if (pathname.startsWith("/okuma/")) {
    const id = decodeURIComponent(pathname.slice("/okuma/".length));
    if (!id) {
      node = renderError("Geçersiz okuma kimliği.");
      setTitle("error");
    } else {
      node = renderResult(router, {
        id,
        // ?paid=1 lands here from Stripe's success_url after Checkout.
        // ?unlocked=true is legacy from the pre-Stripe mock flow — kept
        // tolerated so old test links still render correctly.
        paidRedirect: searchParams.get("paid") === "1",
        unlockedQuery: searchParams.get("unlocked"),
      });
      setTitle("result");
    }
  } else {
    node = renderError();
    setTitle("error");
  }

  appRoot.replaceChildren(node);
  window.scrollTo({ top: 0, behavior: "instant" });
}

window.addEventListener("popstate", () => {
  // Going back from /okuma/:id (or any other URL) lands at "/" → reset to
  // landing. Forward to /okuma/:id re-renders the result page.
  journeyStep = null;
  render(window.location.pathname + window.location.search);
});

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-link]");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("http") || href.startsWith("mailto:")) return;
  ev.preventDefault();
  router.navigate(href);
});

// First render
render(window.location.pathname + window.location.search);
