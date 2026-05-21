// Shared types between the Worker and the vanilla frontend.
// Keep this file pure (no Worker / DOM imports) so the same file can be
// referenced from documentation; the frontend imports the section-title
// table from /public/js/sections.js (mirror of the SECTION_TITLES below).

export interface FormData {
  name: string;
  motherName: string;
  birthDate: string;
  birthPlace: string;
  spouseName?: string;
  question?: string;
}

export interface YildiznameSections {
  kapakSozu: string;
  karakterinOzu: string;
  gizliHuylar: string;
  ruhsalYuk: string;
  askEvlilik: string;
  esinKarakteri: string;
  cocukYuva: string;
  rizkKariyer: string;
  nazarAgirlik: string;
  saglik: string;
  donumNoktalari: string;
}

export type SectionKey = Exclude<keyof YildiznameSections, "kapakSozu">;

export const SECTION_TITLES: Record<SectionKey, string> = {
  karakterinOzu: "Karakterin Özü",
  gizliHuylar: "Gizli Huylar",
  ruhsalYuk: "Ruhsal Yük",
  askEvlilik: "Aşk ve Evlilik",
  esinKarakteri: "İlham ve Esin",
  cocukYuva: "Çocuk ve Yuva",
  rizkKariyer: "Rızk ve Kariyer",
  nazarAgirlik: "Nazar Ağırlığı",
  saglik: "Sağlık",
  donumNoktalari: "Dönüm Noktaları",
};

export const LOCKED_SECTION_KEYS: SectionKey[] = [
  "gizliHuylar",
  "ruhsalYuk",
  "askEvlilik",
  "esinKarakteri",
  "cocukYuva",
  "rizkKariyer",
  "nazarAgirlik",
  "saglik",
  "donumNoktalari",
];

export type ReadingStatus = "pending" | "done" | "error";

export interface Reading {
  id: string;
  formData: FormData;
  sections: YildiznameSections | null;
  status: ReadingStatus;
  error: string | null;
  unlocked: boolean;
  createdAt: string;
}

// Worker bindings, declared via wrangler.toml. The wrangler types generator
// can produce a worker-configuration.d.ts but we keep this hand-rolled mirror
// so the file is reviewable in the repo.
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  READING_PRICE_TRY: string;
}
