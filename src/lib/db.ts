import type { Reading, FormData, YildiznameSections } from "./types";

interface ReadingRow {
  id: string;
  form_data: string;
  sections: string;
  unlocked: number;
  created_at: string;
}

function rowToReading(row: ReadingRow): Reading {
  return {
    id: row.id,
    formData: JSON.parse(row.form_data) as FormData,
    sections: JSON.parse(row.sections) as YildiznameSections,
    unlocked: row.unlocked === 1,
    createdAt: row.created_at,
  };
}

export async function insertReading(
  db: D1Database,
  reading: Omit<Reading, "createdAt">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO readings (id, form_data, sections, unlocked)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      reading.id,
      JSON.stringify(reading.formData),
      JSON.stringify(reading.sections),
      reading.unlocked ? 1 : 0,
    )
    .run();
}

export async function getReading(
  db: D1Database,
  id: string,
): Promise<Reading | null> {
  const row = await db
    .prepare(
      `SELECT id, form_data, sections, unlocked, created_at
       FROM readings WHERE id = ?`,
    )
    .bind(id)
    .first<ReadingRow>();
  return row ? rowToReading(row) : null;
}

export async function unlockReading(
  db: D1Database,
  id: string,
): Promise<Reading | null> {
  const res = await db
    .prepare(`UPDATE readings SET unlocked = 1 WHERE id = ?`)
    .bind(id)
    .run();
  if (!res.success || (res.meta?.changes ?? 0) === 0) {
    return null;
  }
  return getReading(db, id);
}
