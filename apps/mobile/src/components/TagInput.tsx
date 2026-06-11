import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Chip, TextInput } from "react-native-paper";

import { addTag, suggestionsFor } from "../lib/tags";

interface TagInputProps {
  /** Current tags (already normalized). */
  tags: string[];
  /** Called with the next tags array on add/remove. */
  onChange: (tags: string[]) => void;
  /** Known vault tags for autocomplete, count-sorted (most-used first). */
  knownTags?: string[];
  label?: string;
}

/**
 * Chip-style tag entry with vault autocomplete. Typing a space or comma
 * finalizes the current token (fast multi-tag entry); tapping a suggestion or
 * pressing return commits it; chips are removable. All tags are normalized on
 * the way in, so the frontmatter stays canonical.
 */
export function TagInput({ tags, onChange, knownTags = [], label = "Tags" }: TagInputProps) {
  const [draft, setDraft] = useState("");

  const suggestions = useMemo(
    () => (draft.trim() ? suggestionsFor(knownTags, draft, tags) : []),
    [knownTags, draft, tags],
  );

  const commit = (raw: string): void => {
    const next = addTag(tags, raw);
    if (next !== tags) onChange(next);
    setDraft("");
  };

  const onChangeText = (text: string): void => {
    // A separator (space/comma) finalizes every complete token in the input,
    // keeping only the trailing partial token as the live draft.
    if (/[,\s]/.test(text)) {
      const parts = text.split(/[,\s]+/);
      const trailing = parts.pop() ?? "";
      let acc = tags;
      for (const part of parts) acc = addTag(acc, part);
      if (acc !== tags) onChange(acc);
      setDraft(trailing);
      return;
    }
    setDraft(text);
  };

  const remove = (tag: string): void => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <View style={styles.block}>
      <TextInput
        mode="outlined"
        label={label}
        dense
        value={draft}
        onChangeText={onChangeText}
        onSubmitEditing={() => commit(draft)}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Add a tag…"
        left={<TextInput.Icon icon="tag-outline" />}
      />
      {suggestions.length > 0 && (
        <View style={styles.suggestRow}>
          {suggestions.map((tag) => (
            <Chip key={`suggest-${tag}`} compact mode="outlined" onPress={() => commit(tag)}>
              {tag}
            </Chip>
          ))}
        </View>
      )}
      {tags.length > 0 && (
        <View style={styles.chipRow}>
          {tags.map((tag) => (
            <Chip key={tag} compact icon="tag" onClose={() => remove(tag)}>
              {tag}
            </Chip>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8, marginTop: 12 },
  suggestRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
