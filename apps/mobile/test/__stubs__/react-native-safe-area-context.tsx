/**
 * Test stub for react-native-safe-area-context. The real module probes a
 * native TurboModule at import time; under vitest there is no native layer,
 * and screen smoke tests don't care about insets — everything reports zero.
 * PaperProvider (react-native-paper) consumes SafeAreaProvider/useSafeAreaInsets.
 */
import { createContext, type ReactNode } from "react";
import { View, type ViewProps } from "react-native";

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const ZERO_FRAME = { x: 0, y: 0, width: 390, height: 844 };

export const SafeAreaInsetsContext = createContext<EdgeInsets>(ZERO_INSETS);
export const SafeAreaFrameContext = createContext(ZERO_FRAME);

export function SafeAreaProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export function SafeAreaView(props: ViewProps) {
  return <View {...props} />;
}

export function useSafeAreaInsets(): EdgeInsets {
  return ZERO_INSETS;
}

export function useSafeAreaFrame() {
  return ZERO_FRAME;
}

export const initialWindowMetrics = {
  insets: ZERO_INSETS,
  frame: ZERO_FRAME,
};
