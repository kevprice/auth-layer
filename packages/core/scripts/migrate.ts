import "dotenv/config";

import { Pool } from "pg";

import { runMigrations } from "../src/db/migrations.js";

const main = async () => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const executed = await runMigrations(pool);
    if (executed.length === 0) {
      console.log("Database is already up to date.");
      return;
    }

    console.log(`Applied migrations: ${executed.join(", ")}`);
  } finally {
    await pool.end();
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
