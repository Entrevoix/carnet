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
import type { CaptureMode } from "./src/lib/storage";

export type RootStackParamList = {
  Home: undefined;
  Capture: { mode: CaptureMode };
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [ready, setReady] = useState(false);

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
    <PaperProvider>
      <NavigationContainer>
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
        </Stack.Navigator>
      </NavigationContainer>
    </PaperProvider>
  );
}
