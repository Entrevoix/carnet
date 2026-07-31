import { StyleSheet, View } from "react-native";
import { Button, Card, TextInput } from "react-native-paper";
import Markdown from "react-native-markdown-display";

import { MarkdownToolbar } from "./MarkdownToolbar";
import type { FormatKind, Sel } from "../lib/markdownEdit";
import { markdownStyle } from "../lib/markdownStyle";
import { caretProps, type CarnetTheme } from "../lib/theme";
import { stripFrontmatter, stripPairedBinaryLinks } from "../lib/writer";

interface NoteMarkdownEditCardProps {
  theme: CarnetTheme;
  /** Full note markdown, frontmatter included — this editor edits raw bytes. */
  draft: string;
  onDraftChange: (next: string) => void;
  /** Transient caret override applied right after a toolbar action. */
  forceSelection: Sel | null;
  onSelectionChange: (next: Sel) => void;
  /** Called when the user types or moves the caret — hands it back to the IME. */
  onCaretReleased: () => void;
  preview: boolean;
  onTogglePreview: () => void;
  /** The preview toggle only exists on the markdown-only path. */
  showPreviewToggle: boolean;
  saving: boolean;
  saveDisabled: boolean;
  onFormat: (kind: FormatKind) => void;
  onInsertImage: () => void;
  onCancel: () => void;
  onSave: () => void;
}

/**
 * The scrolling markdown-source editor. Reached only when the rich editor is
 * gated off: the WYSIWYG path renders full-screen via RichNoteEditor instead.
 */
export function NoteMarkdownEditCard({
  theme,
  draft,
  onDraftChange,
  forceSelection,
  onSelectionChange,
  onCaretReleased,
  preview,
  onTogglePreview,
  showPreviewToggle,
  saving,
  saveDisabled,
  onFormat,
  onInsertImage,
  onCancel,
  onSave,
}: NoteMarkdownEditCardProps) {
  return (
    <Card style={styles.card}>
      <Card.Title title="Editing" subtitle="Markdown + frontmatter" />
      <Card.Content>
        <>
          <MarkdownToolbar
            onFormat={onFormat}
            onInsertImage={onInsertImage}
            disabled={saving}
          />
          <TextInput
            {...caretProps(theme)}
            mode="outlined"
            multiline
            numberOfLines={16}
            value={draft}
            onChangeText={(t) => {
              onDraftChange(t);
              // User is typing — stop forcing the caret so the IME owns it.
              if (forceSelection) onCaretReleased();
            }}
            selection={forceSelection ?? undefined}
            onSelectionChange={(e) => {
              onSelectionChange(e.nativeEvent.selection);
              if (forceSelection) onCaretReleased();
            }}
            style={styles.editor}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {preview ? (
            <View
              style={[
                styles.editPreview,
                { borderTopColor: theme.colors.outlineVariant },
              ]}
            >
              <Markdown style={markdownStyle(theme)}>
                {stripPairedBinaryLinks(stripFrontmatter(draft))}
              </Markdown>
            </View>
          ) : null}
        </>
      </Card.Content>
      <Card.Actions>
        {showPreviewToggle ? (
          <Button
            mode="text"
            icon={preview ? "eye-off" : "eye"}
            onPress={onTogglePreview}
          >
            {preview ? "Hide preview" : "Preview"}
          </Button>
        ) : null}
        <Button onPress={onCancel}>Cancel</Button>
        <Button mode="contained" onPress={onSave} disabled={saveDisabled}>
          Save
        </Button>
      </Card.Actions>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 4 },
  editor: {
    fontFamily: "monospace",
    minHeight: 320,
  },
  // borderTopColor comes from the theme at the usage site (outlineVariant).
  editPreview: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
