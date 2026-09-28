# ZUDE native

The existing Expo application uses Supabase Auth and the ZUDE Express API for business selection and real, read-only Today appointments. Today is the only implemented workspace. Booking, device/PIN authentication, and time-clock behavior are not implemented. Some shell identity/status elements remain legacy previews and do not represent employee attendance.

## ZUDE API connection

Set `EXPO_PUBLIC_ZUDE_API_URL` in the launch/build environment to the API origin (for example, `https://api.example.com`), without an `/api` suffix, credentials, query, or fragment. This milestone does not modify environment files. Keep the existing public Supabase Auth configuration. The API may be reached directly or through the existing Next.js `/api` proxy.

For an iPad on a development LAN, use a reachable computer hostname/address and the API port, not the iPad’s `localhost`. HTTP is allowed only in development builds; production requires HTTPS. Start the existing Express application separately. Reload the native app after changing public configuration. No PostgreSQL or service-role credentials belong in the native environment.

The app sends its current Supabase bearer token to `GET /api/businesses`, then uses the authorized selection for `GET /api/appointments?date=YYYY-MM-DD`. The backend verifies identity and membership on each request. A remembered business ID never grants access. Missing configuration or unavailable API produces an error state; there is no direct-table fallback.

See [the milestone contract and validation notes](../../docs/milestone-01-native-today.md).

## Run on iPad

```sh
cd /Users/ayutacharya/zude-app-worktree/apps/zude-mobile
npx expo start --go --lan
```

Use the same Wi-Fi network on the computer and iPad, then scan the QR code with the iPad camera and open in Expo Go. The existing SDK 57 Expo Go setup is preserved. Rotation is enabled.

## Structure

- `src/theme/tokens.ts`: shared color, type, spacing, border, radius, and layout tokens.
- `src/components/`: native controls, sections, badges, and informational preview dialog.
- `src/lib/api.ts` and `today-api.ts`: authenticated API transport and Today read contracts.
- `src/data/demoToday.ts`: legacy preview fixtures; not the Today appointment data source.
- `src/types/today.ts`: domain and preview types, without a fake service layer.
- `src/navigation/`: responsive shell and future information architecture. No screen navigation is implemented, so no router dependency is needed yet. Adopt Expo Router when adding actual routes.
- `src/features/today/`: operational workspace, appointments, and chronological schedule.

At 900 points the sidebar becomes persistent. In landscape from 1024 points, the workspace uses a 65% main column and 35% schedule rail, with the employee identity consolidated into the Today header. Up Next initially shows the nearest three appointments; View all expands the remaining appointments. Compact availability buttons and attention rows sit directly below. Smaller widths use a full-screen navigation menu and inline schedule. Larger accessibility text also triggers simpler layouts. Unimplemented actions show preview dialogs. Lock is still a placeholder; it does not change authentication or attendance.

## Historical UI foundation validation

Run from this directory:

```sh
npx tsc --noEmit
CI=1 npx expo lint
npx expo install --check
npx expo-doctor
npx expo export --platform ios --output-dir /tmp/zude-m01-ios
```

TypeScript, lint, compatibility checks, Expo Doctor (21/21), and iOS export passed during implementation. The initial foundation was validated by the user on a physical iPad in landscape. The subsequent layout refinement still needs physical-device visual validation.

Resolved setup failures: the initial sandboxed install could not resolve registry.npmjs.org; an authorized network retry succeeded. The initial lint command could not find ESLint; local lint tooling was installed. Expo Doctor initially found a missing expo-font peer; the compatible peer was added.

Remaining tooling warnings: npm reports 10 moderate vulnerabilities, deprecates the Expo-compatible ESLint 9 release, and notes an unapproved optional unrs-resolver install script. Lint succeeds without approving it. No audit fixes, forced upgrades, or script approvals were performed. Metro also emitted an environment-only NO_COLOR/FORCE_COLOR warning.

## Physical-device review checklist

- Review landscape and portrait on iPad, narrow split view, and iPhone.
- Check scrolling, safe areas, keyboard-independent touch controls, and larger text.
- Open and dismiss navigation, every preview, and booking time selections.
- With VoiceOver, review button names, selected Today state, and modal focus.
- Confirm Today shows the selected business’s real appointments, unimplemented actions remain previews, and no action changes records.

The application icon and launch assets remain the original Expo scaffold assets; this milestone brands the in-app shell as ZUDE.
