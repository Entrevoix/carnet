import { ScrollView, StyleSheet } from "react-native";
import { IconButton } from "react-native-paper";

import type { FormatKind } from "../lib/markdownEdit";

interface MarkdownToolbarProps {
  /** Fired with the formatting intent; the screen owns draft/selection and
   * applies the (pure) transform. */
  onFormat: (kind: FormatKind) => void;
  /** Fired by the image button — async pick + writeBinary lives in the screen. */
  onInsertImage: () => void;
  disabled?: boolean;
}

/** MaterialCommunityIcons (react-native-paper's default icon set). */
const BUTTONS: { kind: FormatKind; icon: string; label: string }[] = [
  { kind: "bold", icon: "format-bold", label: "Bold" },
  { kind: "italic", icon: "format-italic", label: "Italic" },
  { kind: "h1", icon: "format-header-1", label: "Heading 1" },
  { kind: "h2", icon: "format-header-2", label: "Heading 2" },
  { kind: "bullet", icon: "format-list-bulleted", label: "Bullet list" },
  { kind: "ordered", icon: "format-list-numbered", label: "Numbered list" },
  { kind: "checkbox", icon: "checkbox-marked-outline", label: "Checklist" },
  { kind: "link", icon: "link-variant", label: "Link" },
  { kind: "code", icon: "code-tags", label: "Inline code" },
];

/**
 * Horizontal, scrollable markdown formatting toolbar for the RecentDetail edit
 * mode. Presentational — it only emits intents; the screen applies the pure
 * `markdownEdit` transforms so undo/dirty tracking stays in one place.
 */
export function MarkdownToolbar({
  onFormat,
  onInsertImage,
  disabled,
}: MarkdownToolbarProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // The toolbar sits above the keyboard while editing; without this the
      // first tap is eaten by keyboard dismissal instead of formatting.
      keyboardShouldPersistTaps="always"
      contentContainerStyle={styles.bar}
    >
      {BUTTONS.map((b) => (
        <IconButton
          key={b.kind}
          icon={b.icon}
          size={22}
          disabled={disabled}
          onPress={() => onFormat(b.kind)}
          accessibilityLabel={b.label}
        />
      ))}
      <IconButton
        icon="image-outline"
        size={22}
        disabled={disabled}
        onPress={onInsertImage}
        accessibilityLabel="Insert image"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { alignItems: "center" },
});
