// Generate the PNG derivatives of our brand SVGs into public/.
// Re-run any time the master SVGs change:
//
//   npm run build:assets
//
// Inputs:
//   public/favicon.svg         master mark (256x256 viewBox)
//   assets/og-source.svg       master OG share card (1200x630)
//
// Outputs:
//   public/apple-touch-icon.png  180x180  iOS home screen
//   public/stripe-icon.png       512x512  upload manually to Stripe Dashboard → Settings → Branding
//   public/og-image.png         1200x630  social link previews
//
// Sharp uses bundled libvips, no system dependency. PNG output is
// optimised by default. Add new sizes by appending to TARGETS below.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const TARGETS = [
  {
    label: "apple-touch-icon",
    source: "public/favicon.svg",
    out: "public/apple-touch-icon.png",
    width: 180,
    height: 180,
  },
  {
    label: "stripe-icon",
    source: "public/favicon.svg",
    out: "public/stripe-icon.png",
    width: 512,
    height: 512,
  },
  {
    label: "og-image",
    source: "assets/og-source.svg",
    out: "public/og-image.png",
    width: 1200,
    height: 630,
  },
];

for (const t of TARGETS) {
  const svg = await readFile(join(ROOT, t.source));
  const png = await sharp(svg, { density: 384 })
    .resize(t.width, t.height, { fit: "cover" })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  await writeFile(join(ROOT, t.out), png);
  console.log(`✓ ${t.label.padEnd(20)} ${t.width}×${t.height}  →  ${t.out}`);
}

console.log("\nAll assets generated.");
