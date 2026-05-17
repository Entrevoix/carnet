// Vitest-only stub for expo-haptics. No-op implementation so production code
// that fires haptics doesn't need to be mocked individually in every test.
export const ImpactFeedbackStyle = {
  Light: "light" as const,
  Medium: "medium" as const,
  Heavy: "heavy" as const,
};

export const impactAsync = async (_style?: string): Promise<void> => {};
export const notificationAsync = async (_type?: string): Promise<void> => {};
export const selectionAsync = async (): Promise<void> => {};
