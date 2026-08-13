// @vitest-environment jsdom
//
// Smoke test for the Places editor: renders the real component tree (react-native
// aliased to react-native-web, real react-native-paper) and drives the two
// resolution paths plus every failure outcome. The resolvers themselves are
// mocked — they have their own unit tests in mapsLink.test.ts / location.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";

vi.mock("../lib/mapsLink", () => ({ resolveMapsLink: vi.fn() }));
vi.mock("../lib/location", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/location")>();
  return { ...actual, resolvePlaceName: vi.fn() };
});

import { PlacesEditor } from "./PlacesEditor";
import { resolveMapsLink } from "../lib/mapsLink";
import { resolvePlaceName } from "../lib/location";
import type { Place } from "../lib/writer";

const rudAlpe: Place = { name: "Rud-Alpe", coords: { lat: 47.2011, lon: 10.1166 } };

function renderEditor(places: Place[] = [], onChange = vi.fn()) {
  render(
    <PaperProvider theme={carnetLight}>
      <PlacesEditor places={places} onChange={onChange} />
    </PaperProvider>,
  );
  return { onChange };
}

/** Type into the field and press Add. */
function addInput(value: string): void {
  fireEvent.change(screen.getByDisplayValue(""), { target: { value } });
  fireEvent.click(screen.getByText("Add"));
}

beforeEach(() => {
  vi.mocked(resolveMapsLink).mockReset();
  vi.mocked(resolvePlaceName).mockReset();
});
afterEach(cleanup);

describe("PlacesEditor", () => {
  it("adds a place by pasting a Maps link", async () => {
    vi.mocked(resolveMapsLink).mockResolvedValue({
      kind: "ok",
      place: "Rud-Alpe",
      coords: { lat: 47.2011, lon: 10.1166 },
    });
    const { onChange } = renderEditor();

    addInput("https://maps.app.goo.gl/AbCdEf");

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([rudAlpe]));
    expect(resolvePlaceName).not.toHaveBeenCalled();
  });

  it("adds a place by typing a name", async () => {
    vi.mocked(resolvePlaceName).mockResolvedValue({
      kind: "ok",
      place: "Lech",
      coords: { lat: 47.2063, lon: 10.1435 },
    });
    const { onChange } = renderEditor();

    addInput("Lech");

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([
        { name: "Lech", coords: { lat: 47.2063, lon: 10.1435 } },
      ]),
    );
    expect(resolveMapsLink).not.toHaveBeenCalled();
  });

  it("appends to the existing list rather than replacing it", async () => {
    vi.mocked(resolvePlaceName).mockResolvedValue({
      kind: "ok",
      place: "Lech",
      coords: { lat: 47.2063, lon: 10.1435 },
    });
    const { onChange } = renderEditor([rudAlpe]);

    addInput("Lech");

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([
        rudAlpe,
        { name: "Lech", coords: { lat: 47.2063, lon: 10.1435 } },
      ]),
    );
  });

  it("renders a chip per place and removes the tapped one", () => {
    const second: Place = { name: "Lech", coords: { lat: 47.2063, lon: 10.1435 } };
    const onChange = vi.fn();
    renderEditor([rudAlpe, second], onChange);

    expect(screen.getByText("Rud-Alpe")).toBeTruthy();
    expect(screen.getByText("Lech")).toBeTruthy();

    // Paper renders the Chip close affordance with an accessible "Close" label.
    fireEvent.click(screen.getAllByLabelText("Close")[0]);
    expect(onChange).toHaveBeenCalledWith([second]);
  });

  it("takes the first candidate and says so when the name is ambiguous", async () => {
    vi.mocked(resolvePlaceName).mockResolvedValue({
      kind: "ambiguous",
      candidates: [
        { place: "Main Street", coords: { lat: 1, lon: 2 } },
        { place: "Main Street", coords: { lat: 3, lon: 4 } },
      ],
    });
    const { onChange } = renderEditor();

    addInput("Main Street");

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([
        { name: "Main Street", coords: { lat: 1, lon: 2 } },
      ]),
    );
    expect(screen.getByText(/Several matches/)).toBeTruthy();
  });

  it("surfaces a notFound outcome inline and adds nothing", async () => {
    vi.mocked(resolvePlaceName).mockResolvedValue({ kind: "notFound" });
    const { onChange } = renderEditor();

    addInput("asdkjfhaskdjf");

    await waitFor(() => expect(screen.getByText(/No match/)).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("surfaces an invalidLink outcome inline", async () => {
    vi.mocked(resolveMapsLink).mockResolvedValue({ kind: "invalidLink" });
    renderEditor();

    addInput("https://example.com");

    await waitFor(() => expect(screen.getByText(/isn't a Google Maps place link/)).toBeTruthy());
  });

  it("surfaces a resolver error message inline", async () => {
    vi.mocked(resolveMapsLink).mockResolvedValue({
      kind: "error",
      message: "Could not resolve the Maps link.",
    });
    renderEditor();

    addInput("https://maps.app.goo.gl/AbCdEf");

    await waitFor(() =>
      expect(screen.getByText(/Could not resolve the Maps link\./)).toBeTruthy(),
    );
  });

  it("disables Add while a resolution is in flight", async () => {
    let release!: (o: { kind: "notFound" }) => void;
    vi.mocked(resolvePlaceName).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderEditor();

    addInput("Lech");

    const addButton = screen.getByText("Add").closest("button");
    await waitFor(() => expect(addButton?.disabled).toBe(true));

    release({ kind: "notFound" });
    await waitFor(() => expect(screen.getByText(/No match/)).toBeTruthy());
  });

  it("does nothing on an empty input", () => {
    renderEditor();
    fireEvent.click(screen.getByText("Add"));
    expect(resolvePlaceName).not.toHaveBeenCalled();
    expect(resolveMapsLink).not.toHaveBeenCalled();
  });
});
