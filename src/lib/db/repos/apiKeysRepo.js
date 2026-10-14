import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { decryptColumn, encryptLookupColumn, keyLookupCandidates } from "../helpers/secretCrypto.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: decryptColumn(row.key),
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = await db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = await db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  // The key column is deterministically encrypted (fork), so a plaintext equality
  // lookup would miss every migrated row. Try the sealed form plus the bare
  // plaintext, mirroring validateApiKey.
  const candidates = keyLookupCandidates(key);
  const placeholders = candidates.map(() => "?").join(", ");
  const row = await db.get(`SELECT * FROM apiKeys WHERE key IN (${placeholders})`, candidates);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  await db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, encryptLookupColumn(apiKey.key), apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  // Returned from the callback rather than assigned to an outer variable: the
  // Postgres adapter re-runs the callback on a serialization failure, and an
  // outer assignment would survive the discarded attempt.
  return await db.transaction(async () => {
    const row = await db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return null;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    await db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [encryptLookupColumn(merged.key), merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, id]
    );
    // Re-read so the returned record reflects exactly what was persisted.
    return rowToKey(await db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = await db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  // The key column is deterministically encrypted, so this stays a single indexed
  // equality lookup — it runs on every gateway request. Two candidates are tried:
  // the sealed form, plus the bare plaintext for rows not rewritten yet.
  const candidates = keyLookupCandidates(key);
  const placeholders = candidates.map(() => "?").join(", ");
  const row = await db.get(`SELECT isActive FROM apiKeys WHERE key IN (${placeholders})`, candidates);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
