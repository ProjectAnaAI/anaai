import {
  initialWindowMetrics,
  SafeAreaProvider,
} from "react-native-safe-area-context";
import { AuthGate } from "./src/features/auth/AuthGate";

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AuthGate />
    </SafeAreaProvider>
  );
}
