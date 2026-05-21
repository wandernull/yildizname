import type {
  FormData,
  Reading,
  ReadingStatus,
  YildiznameSections,
} from "./types";

interface ReadingRow {
  id: string;
  form_data: string;
  sections: string;
  unlocked: number;
  status: ReadingStatus;
  error: string | null;
  created_at: string;
}

function rowToReading(row: ReadingRow): Reading {
  let sections: YildiznameSections | null = null;
  if (row.sections && row.sections !== "{}" && row.sections !== "") {
    try {
      sections = JSON.parse(row.sections) as YildiznameSections;
    } catch {
      sections = null;
    }
  }
  return {
    id: row.id,
    formData: JSON.parse(row.form_data) as FormData,
    sections,
    status: row.status,
    error: row.error,
    unlocked: row.unlocked === 1,
    createdAt: row.created_at,
  };
}

// /api/generate is synchronous (see src/index.ts) so we just write the
// finished row in one go. The status/error columns from migration 0002 are
// retained for future use (e.g. a background-job consumer if we ever move
// off Workers Free) but the synchronous path always writes status='done'
// via the default — no need to set it explicitly.
export async function insertReading(
  db: D1Database,
  reading: { id: string; formData: FormData; sections: YildiznameSections; unlocked: boolean },
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
      `SELECT id, form_data, sections, unlocked, status, error, created_at
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
