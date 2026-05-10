import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const SETTINGS_KEY = "carnet:settings:v1";

describe("getSettings — keychain migration", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
    vi.resetModules();
  });

  it("migrates a legacy localStorage token to the keychain on first read", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_navetted_token") return Promise.resolve(null);
      if (cmd === "set_navetted_token") return Promise.resolve();
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        navettedUrl: "ws://migrated.example:7878",
        omniRouteUrl: "http://omni.example",
        navettedToken: "legacy-secret",
      }),
    );

    const { getSettings } = await import("./storage.js");
    const settings = await getSettings();

    expect(settings.navettedToken).toBe("legacy-secret");
    expect(settings.navettedUrl).toBe("ws://migrated.example:7878");
    expect(settings.omniRouteUrl).toBe("http://omni.example");

    expect(invokeMock).toHaveBeenCalledWith("set_navetted_token", {
      token: "legacy-secret",
    });

    const persistedRaw = localStorage.getItem(SETTINGS_KEY);
    expect(persistedRaw).not.toBeNull();
    const persisted = JSON.parse(persistedRaw!) as Record<string, unknown>;
    expect(persisted.navettedToken).toBeUndefined();
    expect(persisted.navettedUrl).toBe("ws://migrated.example:7878");
  });

  it("does not re-migrate on a second read after migration completes", async () => {
    let keychainContents: string | null = null;
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_navetted_token")
          return Promise.resolve(keychainContents);
        if (cmd === "set_navetted_token") {
          keychainContents = args?.token as string;
          return Promise.resolve();
        }
        throw new Error(`unexpected invoke: ${cmd}`);
      },
    );
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        navettedUrl: "ws://x:7878",
        omniRouteUrl: "",
        navettedToken: "once",
      }),
    );

    const { getSettings } = await import("./storage.js");

    const first = await getSettings();
    expect(first.navettedToken).toBe("once");
    const setCallsAfterFirst = invokeMock.mock.calls.filter(
      (c) => c[0] === "set_navetted_token",
    ).length;
    expect(setCallsAfterFirst).toBe(1);

    const second = await getSettings();
    expect(second.navettedToken).toBe("once");
    const setCallsAfterSecond = invokeMock.mock.calls.filter(
      (c) => c[0] === "set_navetted_token",
    ).length;
    expect(setCallsAfterSecond).toBe(1); // no second migration write
  });

  it("does nothing when neither store has a token", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_navetted_token") return Promise.resolve(null);
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const { getSettings } = await import("./storage.js");
    const settings = await getSettings();

    expect(settings.navettedToken).toBe("");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "set_navetted_token",
      expect.anything(),
    );
  });

  it("strips the legacy localStorage field even when the keychain already holds a token", async () => {
    // Simulates a prior migration where the keychain write succeeded but
    // the localStorage strip was interrupted (process kill / crash). On the
    // next read, getSettings should clean up the lingering legacy field.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_navetted_token")
        return Promise.resolve("already-in-keychain");
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        navettedUrl: "ws://x:7878",
        omniRouteUrl: "",
        navettedToken: "stale-legacy",
      }),
    );

    const { getSettings } = await import("./storage.js");
    const settings = await getSettings();

    expect(settings.navettedToken).toBe("already-in-keychain");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "set_navetted_token",
      expect.anything(),
    );

    const persisted = JSON.parse(localStorage.getItem(SETTINGS_KEY)!) as Record<
      string,
      unknown
    >;
    expect(persisted.navettedToken).toBeUndefined();
  });
});
