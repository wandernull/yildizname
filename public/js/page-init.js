// Lightweight init for static content pages (/yildizname, /ebced, etc.)
// — wires the shared starfield + shooting-star animations onto the page
// without pulling in the SPA's router or view system.
import { initShootingStars, initStarfield } from "./bg.js";

const starCanvas = document.getElementById("starfield");
if (starCanvas) initStarfield(starCanvas);

const shootingHost = document.getElementById("shooting-star-host");
if (shootingHost) initShootingStars(shootingHost);
