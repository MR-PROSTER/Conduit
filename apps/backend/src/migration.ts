import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { SupabaseClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Reads migration_patch.sql and runs it via supabase.rpc('exec_sql').
 * This is safe to re-run.
 */
export async function runMigrations(supabaseClient: SupabaseClient): Promise<void> {
  const candidatePaths = [
    path.join(__dirname, "../sql/migration_patch.sql"),
    path.join(__dirname, "../../sql/migration_patch.sql"),
    path.join(__dirname, "sql/migration_patch.sql"),
    path.join(process.cwd(), "sql/migration_patch.sql"),
    path.join(process.cwd(), "apps/backend/sql/migration_patch.sql"),
  ];

  let sqlContent = "";
  let foundPath = "";

  for (const candidate of candidatePaths) {
    try {
      sqlContent = await fs.readFile(candidate, "utf-8");
      foundPath = candidate;
      break;
    } catch {
      // Continue to next candidate
    }
  }

  if (!sqlContent) {
    throw new Error(
      `Could not find migration_patch.sql in any of the expected paths:\n${candidatePaths.join("\n")}`,
    );
  }

  console.log(`Reading migration patch from: ${foundPath}`);

  // Call the 'exec_sql' RPC function in Supabase
  const { error } = await supabaseClient.rpc("exec_sql", { sql: sqlContent });

  if (error) {
    console.warn(`[WARNING] Migration RPC execution failed: ${error.message} (${error.code})`);
    if (
      error.code === "PGRST202" ||
      error.message.includes("exec_sql") ||
      error.message.includes("function")
    ) {
      console.warn(
        `\n[WARNING] The RPC function 'exec_sql' was not found in your Supabase database.` +
          `\nPlease ensure that you have run the full schema setup script or created the following RPC function in your Supabase SQL Editor:` +
          `\n\nCREATE OR REPLACE FUNCTION exec_sql(sql text)` +
          `\nRETURNS void AS $$` +
          `\nBEGIN` +
          `\n    EXECUTE sql;` +
          `\nEND;` +
          `\n$$ LANGUAGE plpgsql SECURITY DEFINER;\n`,
      );
      console.log("Skipping migrations as exec_sql is not available. Server will attempt to start anyway.");
      return;
    }
    throw new Error(`Migration failed: ${error.message}`);
  }

  console.log("Migration patch executed successfully.");
}
