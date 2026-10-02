import { clearAccountProof } from "./account-proof";
import { supabase } from "./supabase";

// Signs this app installation out of the ZUDE account. Local scope only: the
// account's sessions on other devices are untouched. A registered shared
// device stays registered and stays in shared-device mode.
export async function signOutAccount() {
  clearAccountProof();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw new Error("Sign out failed.");
}
