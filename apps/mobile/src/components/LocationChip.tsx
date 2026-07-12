import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Chip, HelperText, TextInput } from "react-native-paper";

import { describeCoords, formatCoords, getCurrentCoords, parseCoords } from "../lib/location";
import { caretProps, useCarnetTheme } from "../lib/theme";

interface LocationChipProps {
  /** Current location as a `lat,lon` string, or null. */
  location: string | null;
  onChange: (location: string | null) => void;
}

/**
 * Capture-time location affordance: tap "Location" to use the device fix
 * (prompting for permission as needed), or "Enter" to type coordinates by hand.
 * Once set, shows a removable chip with the coords and a best-effort place name.
 * Stores only `lat,lon` — no map, no persisted address (display label only).
 */
export function LocationChip({ location, onChange }: LocationChipProps) {
  const theme = useCarnetTheme();
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [place, setPlace] = useState<string | null>(null);

  // Reverse-geocode for a friendlier chip label (display only, never persisted).
  useEffect(() => {
    let active = true;
    setPlace(null);
    const coords = location ? parseCoords(location) : null;
    if (coords) {
      void describeCoords(coords)
        .then((label) => {
          if (active) setPlace(label);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [location]);

  const useCurrent = async (): Promise<void> => {
    setError(null);
    setFetching(true);
    try {
      const coords = await getCurrentCoords();
      if (!coords) {
        setError("Location unavailable — grant permission or enter coordinates.");
        return;
      }
      onChange(formatCoords(coords));
      setManualOpen(false);
    } finally {
      setFetching(false);
    }
  };

  const commitManual = (): void => {
    const coords = parseCoords(manualText);
    if (!coords) {
      setError("Enter coordinates as lat,lon (e.g. 38.9072,-77.0369).");
      return;
    }
    onChange(formatCoords(coords));
    setManualText("");
    setManualOpen(false);
    setError(null);
  };

  if (location) {
    return (
      <View style={styles.block}>
        <View style={styles.chipRow}>
          <Chip icon="map-marker" onClose={() => onChange(null)} compact>
            {place ? `${place} · ${location}` : location}
          </Chip>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <Button
          icon="map-marker"
          mode="contained-tonal"
          compact
          loading={fetching}
          disabled={fetching}
          onPress={useCurrent}
        >
          Location
        </Button>
        <Button icon="pencil" mode="text" compact onPress={() => setManualOpen((open) => !open)}>
          Enter
        </Button>
      </View>
      {manualOpen && (
        <TextInput
          {...caretProps(theme)}
          mode="outlined"
          dense
          label="lat,lon"
          value={manualText}
          onChangeText={setManualText}
          onSubmitEditing={commitManual}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="38.9072,-77.0369"
          right={<TextInput.Icon icon="check" onPress={commitManual} />}
        />
      )}
      {error && (
        <HelperText type="error" visible>
          {error}
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
