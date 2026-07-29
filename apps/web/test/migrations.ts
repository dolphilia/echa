export async function applySqlMigration(
  database: D1Database,
  migration: string,
): Promise<void> {
  const statements = migration
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
  await database.batch(statements);
}
