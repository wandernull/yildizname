-- Question topic + hook line, produced by the same generation call (no
-- extra LLM cost). Used to aim the free preview's closing "open loop", the
-- price-modal exit hook and the win-back email at the thing each reader
-- actually asked about ("Kişinin en çok merak ettiği" — filled on ~85% of
-- readings), and to let the admin see which topics convert.
--
--   question_topic  one of: ask | aile | kariyer | para | saglik | ruhsal |
--                   genel. With no question, the model picks the topic the
--                   reading makes most compelling (asked-or-not is read
--                   from form_data.question). The locked section that
--                   answers it is derived in code (TOPIC_SECTION in
--                   src/lib/types.ts), not stored.
--   hook_line       one suspenseful sentence (<= ~160 chars) grounded in that
--                   section's real content, ending before the answer.
--
-- NULL on readings generated before this migration.
ALTER TABLE readings ADD COLUMN question_topic TEXT;
ALTER TABLE readings ADD COLUMN hook_line TEXT;
