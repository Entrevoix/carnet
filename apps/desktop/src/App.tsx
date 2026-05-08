import { HashRouter, Route, Routes } from "react-router-dom";

import HomeScreen from "./screens/HomeScreen";
import CaptureScreen from "./screens/CaptureScreen";
import SettingsScreen from "./screens/SettingsScreen";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<HomeScreen />} />
        <Route path="/capture/:mode" element={<CaptureScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
      </Routes>
    </HashRouter>
  );
}
