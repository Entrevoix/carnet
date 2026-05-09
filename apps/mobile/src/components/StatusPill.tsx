import { StyleSheet } from "react-native";
import { Chip } from "react-native-paper";
import type { ConnectionStatus } from "@carnet/shared";

import { useConnectionStatus } from "../lib/useConnectionStatus";

const COLORS: Record<ConnectionStatus, { bg: string; fg: string; label: string }> = {
  connected:       { bg: "#1f7a1f", fg: "#ffffff", label: "connecté" },
  connecting:      { bg: "#a36b00", fg: "#ffffff", label: "connexion…" },
  authenticating:  { bg: "#a36b00", fg: "#ffffff", label: "auth…" },
  reconnecting:    { bg: "#a36b00", fg: "#ffffff", label: "reconnexion…" },
  error:           { bg: "#a83232", fg: "#ffffff", label: "erreur" },
  disconnected:    { bg: "#5a5a5a", fg: "#ffffff", label: "hors ligne" },
};

export function StatusPill() {
  const status = useConnectionStatus();
  const palette = COLORS[status];
  return (
    <Chip
      compact
      style={[styles.chip, { backgroundColor: palette.bg }]}
      textStyle={{ color: palette.fg, fontSize: 11 }}
    >
      {palette.label}
    </Chip>
  );
}

const styles = StyleSheet.create({
  chip: { marginRight: 4 },
});
