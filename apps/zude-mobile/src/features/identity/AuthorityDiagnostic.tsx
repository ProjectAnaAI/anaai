import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Text, View } from "react-native";
import { Button, styles as ui } from "../../components/ui";
import { checkAuthority } from "../../lib/authority-diagnostic";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "./EmployeeIdentityContext";

export function AuthorityDiagnostic() {
  const { business, userId } = useBusiness();
  const { identity, device, sharedMode, vault } = useEmployeeIdentity();
  const scope = useMemo(() => ({ businessId: business.id, userId, identity, device, sharedMode, vault }),
    [business.id, userId, identity, device, sharedMode, vault]);
  const [snapshot, setSnapshot] = useState<{ scope: object; result?: Awaited<ReturnType<typeof checkAuthority>>; status: string } | null>(null);
  const result = snapshot?.scope === scope ? snapshot.result : null;
  const status = snapshot?.scope === scope ? snapshot.status : "";
  const request = useRef({ generation: 0 });
  useEffect(() => {
    const pending = request.current;
    pending.generation++;
    const listener = AppState.addEventListener("change", () => {
      pending.generation++;
      setSnapshot(null);
    });
    return () => { pending.generation++; listener.remove(); };
  }, [scope]);
  async function check() {
    const generation = ++request.current.generation;
    setSnapshot({ scope, status: "Checking…" });
    try {
      const verified = await checkAuthority(business.id, userId, sharedMode);
      if (generation === request.current.generation) setSnapshot({ scope, result: verified, status: "" });
    } catch {
      // Never display arbitrary error bodies or retain a previously verified role.
      if (generation === request.current.generation) setSnapshot({ scope, status: "Not verified. Session may be expired, changed, or unavailable. Unlock again and retry." });
    }
  }
  return <View style={{ gap: 8 }}>
    <Text style={ui.strong}>Development authority check</Text>
    <Text style={ui.meta}>Read-only snapshot; cleared on identity change or backgrounding. Project is this app’s Auth configuration.</Text>
    <Button secondary label="Check current authority" disabled={vault !== "ready" || !!device && device.businessId !== business.id || status === "Checking…"} onPress={() => void check()} />
    {!!status && <Text style={ui.meta}>{status}</Text>}
    {result && <>
      <Text style={ui.body}>Business: {result.business}</Text>
      <Text style={ui.body}>Account membership: {result.accountRole}</Text>
      <Text style={ui.body}>PIN session: {result.pinStatus}</Text>
      <Text style={ui.body}>PIN role: {result.pinRole}</Text>
      <Text style={ui.body}>Effective management authority: {result.effectiveRole}</Text>
      <Text style={ui.meta}>Supabase Auth project: {result.project}</Text>
    </>}
  </View>;
}
