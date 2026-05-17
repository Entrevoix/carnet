// Vitest-only stub for expo-sqlite. The real module is native + Flow-typed.
// Tests replace these via vi.mock() in the test file.
export interface SQLiteDatabase {
  execAsync: (sql: string) => Promise<void>;
  getAllAsync: <T>(sql: string, ...params: unknown[]) => Promise<T[]>;
  runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
}

export const openDatabaseAsync = async (
  _name: string,
): Promise<SQLiteDatabase> => {
  throw new Error("expo-sqlite stub: vi.mock() this module in tests");
};
