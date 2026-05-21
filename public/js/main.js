// Entry point: initialise the background animations, set up History API
// routing, and render the right view for the current URL. Any anchor with
// `data-link` is intercepted and routed client-side; other links and
// navigations work as full page loads (e.g. external).

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

// ----- router ---------------------------------------------------------------

const router = {
  navigate(path, opts = {}) {
    const replace = !!opts.replace;
    if (replace) {
      window.history.replaceState({}, "", path);
    } else {
      window.history.pushState({}, "", path);
    }
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

  let node;
  if (pathname === "/" || pathname === "") {
    node = renderLanding();
  } else if (pathname === "/form") {
    node = renderForm(router);
  } else if (pathname === "/loading") {
    node = renderLoading(router);
  } else if (pathname.startsWith("/result/")) {
    const id = decodeURIComponent(pathname.slice("/result/".length));
    if (!id) {
      node = renderError("Geçersiz okuma kimliği.");
    } else {
      node = renderResult(router, {
        id,
        unlockedQuery: searchParams.get("unlocked"),
      });
    }
  } else {
    node = renderError();
  }

  appRoot.replaceChildren(node);
  // Reset scroll on view change.
  window.scrollTo({ top: 0, behavior: "instant" });
}

window.addEventListener("popstate", () => {
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
