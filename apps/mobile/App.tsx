import "react-native-gesture-handler";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { PaperProvider } from "react-native-paper";
import { StatusBar } from "expo-status-bar";

import HomeScreen from "./src/screens/HomeScreen";
import CaptureScreen from "./src/screens/CaptureScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import PairScreen from "./src/screens/PairScreen";
import { getSettings } from "./src/lib/settings";
import type { CaptureMode } from "./src/lib/storage";

export type RootStackParamList = {
  Home: undefined;
  Capture: { mode: CaptureMode };
  Settings: undefined;
  Pair: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

type InitialRoute = keyof RootStackParamList;

export default function App() {
  const [initialRoute, setInitialRoute] = useState<InitialRoute | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const settings = await getSettings();
        // First launch heuristic: if the user hasn't pasted a token yet,
        // route to PairScreen. Token is the only field that *must* be set.
        const hasToken = settings.navettedToken.trim().length > 0;
        setInitialRoute(hasToken ? "Home" : "Pair");
      } catch {
        // AsyncStorage native failure → default to Pair so the user can
        // recover via QR scan or manual entry instead of seeing a stuck
        // spinner with no way out.
        setInitialRoute("Pair");
      }
    })();
  }, []);

  if (!initialRoute) {
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
    <PaperProvider>
      <NavigationContainer>
        <StatusBar style="auto" />
        <Stack.Navigator initialRouteName={initialRoute}>
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
                  ? "Idée"
                  : route.params.mode === "journal"
                    ? "Journal"
                    : "Contact",
            })}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: "Paramètres" }}
          />
          <Stack.Screen
            name="Pair"
            component={PairScreen}
            options={{ headerShown: false }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </PaperProvider>
  );
}
