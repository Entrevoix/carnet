import "react-native-gesture-handler";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, useColorScheme, View } from "react-native";
import {
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavLightTheme,
  type LinkingOptions,
  NavigationContainer,
  useNavigationContainerRef,
  type NavigationContainerRefWithCurrent,
  type Theme as NavTheme,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { PaperProvider } from "react-native-paper";
import { StatusBar } from "expo-status-bar";
import { ShareIntentProvider, useShareIntentContext } from "expo-share-intent";

import HomeScreen from "./src/screens/HomeScreen";
import CaptureScreen from "./src/screens/CaptureScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import ShareReceiveScreen from "./src/screens/ShareReceiveScreen";
import PhotoCaptureScreen from "./src/screens/PhotoCaptureScreen";
import AudioCaptureScreen from "./src/screens/AudioCaptureScreen";
import RecentDetailScreen from "./src/screens/RecentDetailScreen";
import type { CaptureEntry, CaptureMode } from "./src/lib/storage";
import { inkAndMistDark, inkAndMistLight } from "./src/lib/theme";

export type RootStackParamList = {
  Home: undefined;
  Capture: { mode: CaptureMode };
  Settings: undefined;
  ShareReceive: undefined;
  PhotoCapture: undefined;
  AudioCapture: undefined;
  RecentDetail: { entry: CaptureEntry };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Deep-link routing. Drives the Android app-shortcuts (long-press launcher
// icon → Idea/Journal/Photo/Contact) and any other carnet:// URI the OS
// hands the app. The custom scheme is declared in app.json; this config
// only maps URL paths to stack screens.
//
// SECURITY MODEL — deep-link routes are passive. They navigate; they never
// auto-act on params. The carnet:// scheme is global on the device, so any
// other app can fire a VIEW intent at us. Every screen reachable via this
// linking config is a passive form where the user has to tap Save (or an
// equivalent action) before anything is written. If a future route gains
// an auto-action (e.g. carnet://import?url=X that fetches + saves), it
// MUST validate the param and surface a user-confirm step before firing.
//
// RecentDetail is intentionally omitted — its param is a CaptureEntry
// object which can't be url-encoded cleanly. Deep-linking into a specific
// recent isn't a use case we're solving today.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["carnet://"],
  config: {
    screens: {
      Home: "",
      Capture: "capture/:mode",
      PhotoCapture: "photo",
      AudioCapture: "audio",
      Settings: "settings",
      ShareReceive: "share-receive",
    },
  },
};

/**
 * Watches for incoming Android share intents and routes to ShareReceive
 * exactly once per intent. The `routedKey` ref prevents re-routing when the
 * provider re-renders with the same intent payload still attached.
 */
function ShareIntentRouter({
  navigation,
}: {
  navigation: NavigationContainerRefWithCurrent<RootStackParamList>;
}) {
  const { hasShareIntent, shareIntent } = useShareIntentContext();
  const routedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent) {
      // Share was reset (Cancel / Done) — clear the dedup key so a *second*
      // identical share later in the session still routes. Without this,
      // the same image shared twice in a row is silently dropped.
      routedKey.current = null;
      return;
    }
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
  // Mirror the OS light/dark setting. userInterfaceStyle="automatic" in
  // app.json lets the system flip; this hook reflects the live preference.
  const colorScheme = useColorScheme();
  const paperTheme = colorScheme === "dark" ? inkAndMistDark : inkAndMistLight;
  // Derive a React Navigation theme so the native-stack header bar matches
  // the Paper-themed screen body. Without this, the header would render
  // with RN Navigation's default light theme on top of our ink-dark surface.
  const navTheme: NavTheme = {
    ...(colorScheme === "dark" ? NavDarkTheme : NavLightTheme),
    colors: {
      ...(colorScheme === "dark" ? NavDarkTheme : NavLightTheme).colors,
      primary: paperTheme.colors.primary,
      background: paperTheme.colors.background,
      card: paperTheme.colors.surface,
      text: paperTheme.colors.onSurface,
      border: paperTheme.colors.outline,
      notification: paperTheme.colors.error,
    },
  };

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
          backgroundColor: paperTheme.colors.background,
        }}
      >
        <ActivityIndicator color={paperTheme.colors.primary} />
      </View>
    );
  }

  return (
    <ShareIntentProvider>
      <PaperProvider theme={paperTheme}>
        <NavigationContainer ref={navRef} theme={navTheme} linking={linking}>
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
            <Stack.Screen
              name="PhotoCapture"
              component={PhotoCaptureScreen}
              options={{ title: "Photo" }}
            />
            <Stack.Screen
              name="AudioCapture"
              component={AudioCaptureScreen}
              options={{ title: "Audio" }}
            />
            <Stack.Screen
              name="RecentDetail"
              component={RecentDetailScreen}
              options={({ route }) => ({ title: route.params.entry.title })}
            />
          </Stack.Navigator>
          <ShareIntentRouter navigation={navRef} />
        </NavigationContainer>
      </PaperProvider>
    </ShareIntentProvider>
  );
}
