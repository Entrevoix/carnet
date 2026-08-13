import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Chip, HelperText, TextInput } from "react-native-paper";

import { formatCoords, resolvePlaceName, type ResolvePlaceOutcome } from "../lib/location";
import { resolveMapsLink } from "../lib/mapsLink";
import { caretProps, useCarnetTheme } from "../lib/theme";
import type { Place } from "../lib/writer";

interface PlacesEditorProps {
  places: Place[];
  onChange: (places: Place[]) => void;
}

/** Turn a non-"ok" outcome into the inline message shown under the field. */
function errorFor(outcome: ResolvePlaceOutcome): string {
  switch (outcome.kind) {
    case "notFound":
      return "No match — try a more specific name, or paste a Maps link.";
    case "invalidLink":
      return "That link isn't a Google Maps place link.";
    case "error":
      return `Couldn't resolve that place: ${outcome.message}`;
    default:
      return "Couldn't resolve that place.";
  }
}

/**
 * Capture-time places affordance (Journal only): paste a Google Maps link or
 * type a place name, tap Add, and the resolved place lands as a removable chip.
 * Several places can be attached to one entry — unlike the single whole-day
 * LocationChip, these are entry-scoped and written into the note body.
 *
 * Presentational + resolution only; CaptureScreen owns the list.
 */
export function PlacesEditor({ places, onChange }: PlacesEditorProps) {
  const theme = useCarnetTheme();
  const [text, setText] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    const raw = text.trim();
    if (!raw || resolving) return;
    setError(null);
    setNote(null);
    setResolving(true);
    try {
      // A URL goes to the Maps-link resolver; anything else is a place name.
      const outcome = /^https?:\/\//i.test(raw)
        ? await resolveMapsLink(raw)
        : await resolvePlaceName(raw);

      if (outcome.kind === "ok") {
        onChange([...places, { name: outcome.place, coords: outcome.coords }]);
        setText("");
        return;
      }
      if (outcome.kind === "ambiguous") {
        // Take the first match and say so, rather than blocking on a picker —
        // the user can remove and retype a more specific name.
        const [first] = outcome.candidates;
        onChange([...places, { name: first.place, coords: first.coords }]);
        setText("");
        setNote(
          `Several matches — used the first (${formatCoords(first.coords)}). Remove and be more specific if that's wrong.`,
        );
        return;
      }
      setError(errorFor(outcome));
    } finally {
      setResolving(false);
    }
  };

  const remove = (index: number): void => {
    onChange(places.filter((_, i) => i !== index));
  };

  return (
    <View style={styles.block}>
      <TextInput
        {...caretProps(theme)}
        mode="outlined"
        dense
        label="Place or Maps link"
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => void add()}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Rud-Alpe, or https://maps.app.goo.gl/…"
      />
      <View style={styles.row}>
        <Button
          icon="map-marker-plus"
          mode="contained-tonal"
          compact
          loading={resolving}
          disabled={resolving || text.trim().length === 0}
          onPress={() => void add()}
        >
          Add
        </Button>
      </View>
      {places.length > 0 && (
        <View style={styles.chipRow}>
          {places.map((p, i) => (
            <Chip
              key={`${p.name}-${formatCoords(p.coords)}-${i}`}
              icon="map-marker"
              onClose={() => remove(i)}
              compact
            >
              {p.name}
            </Chip>
          ))}
        </View>
      )}
      {error && (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      )}
      {note && !error && (
        <HelperText type="info" visible>
          {note}
        </HelperText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8, marginTop: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
