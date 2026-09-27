# ZUDE native · Milestone 01

A native Expo Go UI foundation. Today is the only implemented workspace. All data is a local fixture, fixed at September 26, 2026, 10:20 AM; the clock does not tick. No authentication, network calls, booking mutations, staff scheduling, or time-clock behavior is implemented.

## Run on iPad

```sh
cd /Users/ayutacharya/zude-app-worktree/apps/zude-mobile
npx expo start --go --lan
```

Use the same Wi-Fi network on the computer and iPad, then scan the QR code with the iPad camera and open in Expo Go. The existing SDK 57 Expo Go setup is preserved. Rotation is enabled.

## Structure

- `src/theme/tokens.ts`: shared color, type, spacing, border, radius, and layout tokens.
- `src/components/`: native controls, sections, badges, and informational preview dialog.
- `src/data/demoToday.ts`: isolated demo day, appointments, openings, and attention items.
- `src/types/today.ts`: domain and preview types, without a fake service layer.
- `src/navigation/`: responsive shell and future information architecture. No screen navigation is implemented, so no router dependency is needed yet. Adopt Expo Router when adding actual routes.
- `src/features/today/`: operational workspace, appointments, and chronological schedule.

At 900 points the sidebar becomes persistent. In landscape from 1024 points, the workspace uses a 65% main column and 35% schedule rail, with the employee identity consolidated into the Today header. Up Next initially shows the nearest three appointments; View all expands the remaining appointments. Compact availability buttons and attention rows sit directly below. Smaller widths use a full-screen navigation menu and inline schedule. Larger accessibility text also triggers simpler layouts. All actions show explicitly labeled read-only previews. Lock is only a placeholder and never changes the mock clock status.

## Validation

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
- Confirm Today stays active, preview dialogs clearly identify the local mock behavior, and no action changes records.

The application icon and launch assets remain the original Expo scaffold assets; this milestone brands the in-app shell as ZUDE.
