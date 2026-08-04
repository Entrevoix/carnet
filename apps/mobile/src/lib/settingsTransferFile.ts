import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import { serializeSettingsTransfer } from "./settingsTransfer";
import type { Settings } from "./settings";
import type { ThemePreference } from "./themePreference";

const FILE_NAME = "carnet-settings.json";

export async function shareSettingsTransfer(
  settings: Settings,
  themePreference: ThemePreference,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing is not available on this device.");
  }
  const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!directory) throw new Error("Could not create a settings export file.");
  const uri = `${directory}${FILE_NAME}`;
  await FileSystem.writeAsStringAsync(uri, serializeSettingsTransfer(settings, themePreference), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  await Sharing.shareAsync(uri, {
    dialogTitle: "Export Carnet settings",
    mimeType: "application/json",
  });
}

/** Pick and read an export file, or return null if the picker was cancelled. */
export async function pickSettingsTransfer(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "application/json",
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset) throw new Error("No settings file was selected.");
  return FileSystem.readAsStringAsync(asset.uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}
