/**
 * Vitest-only stub for `expo-file-system/legacy`. The real package's source
 * pulls in expo-modules-core → react-native, whose Flow-typed source rollup's
 * native parser (used by vitest's SSR transform) can't handle. Aliasing this
 * stub at the vitest config level prevents the real module from ever being
 * loaded; individual tests still vi.mock it on top with their own behavior.
 *
 * Functions throw by default so any code path that hits an unmocked call in a
 * test fails loudly instead of silently falling through. Tests that exercise
 * writer.ts override these via vi.mock("expo-file-system/legacy", ...).
 */

export const documentDirectory: string = "file:///stub/";

export const EncodingType = {
  UTF8: "utf8" as const,
  Base64: "base64" as const,
};

const unimplemented = (name: string) =>
  async (..._args: unknown[]): Promise<never> => {
    throw new Error(`[stub] expo-file-system/legacy.${name} not mocked in this test`);
  };

export const getInfoAsync = unimplemented("getInfoAsync");
export const makeDirectoryAsync = unimplemented("makeDirectoryAsync");
export const readAsStringAsync = unimplemented("readAsStringAsync");
export const writeAsStringAsync = unimplemented("writeAsStringAsync");
export const readDirectoryAsync = unimplemented("readDirectoryAsync");
export const deleteAsync = unimplemented("deleteAsync");
export const moveAsync = unimplemented("moveAsync");
export const copyAsync = unimplemented("copyAsync");

export const StorageAccessFramework = {
  readDirectoryAsync: unimplemented("StorageAccessFramework.readDirectoryAsync"),
  makeDirectoryAsync: unimplemented("StorageAccessFramework.makeDirectoryAsync"),
  createFileAsync: unimplemented("StorageAccessFramework.createFileAsync"),
  readAsStringAsync: unimplemented("StorageAccessFramework.readAsStringAsync"),
  writeAsStringAsync: unimplemented("StorageAccessFramework.writeAsStringAsync"),
  requestDirectoryPermissionsAsync: unimplemented(
    "StorageAccessFramework.requestDirectoryPermissionsAsync",
  ),
};
