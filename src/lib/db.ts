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

// Insert a row in the pending state, with the form preserved but no sections
// yet. The background LLM job will later fill them in via completeReading,
// or mark the row failed via failReading.
export async function insertPendingReading(
  db: D1Database,
  id: string,
  form: FormData,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO readings (id, form_data, sections, unlocked, status)
       VALUES (?, ?, '{}', 0, 'pending')`,
    )
    .bind(id, JSON.stringify(form))
    .run();
}

export async function completeReading(
  db: D1Database,
  id: string,
  sections: YildiznameSections,
): Promise<void> {
  await db
    .prepare(
      `UPDATE readings SET sections = ?, status = 'done', error = NULL WHERE id = ?`,
    )
    .bind(JSON.stringify(sections), id)
    .run();
}

export async function failReading(
  db: D1Database,
  id: string,
  message: string,
): Promise<void> {
  await db
    .prepare(`UPDATE readings SET status = 'error', error = ? WHERE id = ?`)
    .bind(message.slice(0, 500), id)
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
