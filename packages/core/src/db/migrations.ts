import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export const migrationTableName = "schema_migrations";

export const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

export const ensureMigrationTable = async (db: Queryable): Promise<void> => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${migrationTableName} (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);
};

export const listMigrationFiles = async (directory = migrationsDirectory): Promise<string[]> => {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
};

export const runMigrations = async (pool: Pool, directory = migrationsDirectory): Promise<string[]> => {
  await ensureMigrationTable(pool);

  const appliedResult = await pool.query<{ name: string }>(`SELECT name FROM ${migrationTableName}`);
  const applied = new Set(appliedResult.rows.map((row) => row.name));
  const files = await listMigrationFiles(directory);
  const executed: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = await readFile(resolve(directory, file), "utf8");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO ${migrationTableName} (name, applied_at) VALUES ($1, $2)`, [file, new Date()]);
      await client.query("COMMIT");
      executed.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return executed;
};
