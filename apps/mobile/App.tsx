import "react-native-gesture-handler";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { PaperProvider } from "react-native-paper";
import { StatusBar } from "expo-status-bar";
import { ShareIntentProvider, useShareIntentContext } from "expo-share-intent";

import HomeScreen from "./src/screens/HomeScreen";
import CaptureScreen from "./src/screens/CaptureScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import ShareReceiveScreen from "./src/screens/ShareReceiveScreen";
import type { CaptureMode } from "./src/lib/storage";

export type RootStackParamList = {
  Home: undefined;
  Capture: { mode: CaptureMode };
  Settings: undefined;
  ShareReceive: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Watches for incoming Android share intents and routes to ShareReceive
 * exactly once per intent. The `routedKey` ref prevents re-routing when the
 * provider re-renders with the same intent payload still attached.
 */
function ShareIntentRouter({
  navigation,
}: {
  navigation: ReturnType<typeof useNavigationContainerRef<RootStackParamList>>;
}) {
  const { hasShareIntent, shareIntent } = useShareIntentContext();
  const routedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent) return;
    // Synthesize a stable key from the payload — re-routes only when a
    // genuinely new share lands.
    const key = `${shareIntent.text ?? ""}|${shareIntent.webUrl ?? ""}|${(shareIntent.files ?? []).map((f) => f.path).join(",")}`;
    if (routedKey.current === key) return;
    routedKey.current = key;
    if (navigation.isReady()) {
      navigation.navigate("ShareReceive");
    }
  }, [hasShareIntent, shareIntent, navigation]);

  return null;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const navRef = useNavigationContainerRef<RootStackParamList>();

  useEffect(() => {
    // Allow async storage to initialise before rendering navigation.
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ShareIntentProvider>
      <PaperProvider>
        <NavigationContainer ref={navRef}>
          <StatusBar style="auto" />
          <Stack.Navigator initialRouteName="Home">
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={{ title: "Carnet" }}
            />
            <Stack.Screen
              name="Capture"
              component={CaptureScreen}
              options={({ route }) => ({
                title:
                  route.params.mode === "idea"
                    ? "Idea"
                    : route.params.mode === "journal"
                      ? "Journal"
                      : "Contact",
              })}
            />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{ title: "Settings" }}
            />
            <Stack.Screen
              name="ShareReceive"
              component={ShareReceiveScreen}
              options={{ title: "Shared" }}
            />
          </Stack.Navigator>
          <ShareIntentRouter navigation={navRef} />
        </NavigationContainer>
      </PaperProvider>
    </ShareIntentProvider>
  );
}
