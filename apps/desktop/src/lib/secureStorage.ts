/**
 * Thin wrappers around the Tauri commands defined in
 * `src-tauri/src/lib.rs`. These call the OS keychain (macOS Keychain /
 * Windows Credential Manager / Linux Secret Service via libsecret) so the
 * navetted token never sits in browser localStorage.
 *
 * Mirrors the shape of mobile's `expo-secure-store` calls so the rest of
 * the storage layer can use a single mental model across platforms.
 */

import { invoke } from "@tauri-apps/api/core";

export async function getNavettedToken(): Promise<string | null> {
  return invoke<string | null>("get_navetted_token");
}

export async function setNavettedToken(token: string): Promise<void> {
  return invoke("set_navetted_token", { token });
}

export async function deleteNavettedToken(): Promise<void> {
  return invoke("delete_navetted_token");
}
