# M04 — Team, Device, PIN and Permissions

ZUDE's shared-device identity layer. A business account signs in with Supabase. An owner or manager registers a shared iPad. Each employee then unlocks that iPad with their own PIN.

**Status:** M04 code is complete. The live migration `202609290001_m04_team_device_identity.sql` has already been applied and verified by the operator. This pass added no migration and executed no SQL. Physical-iPad validation is still outstanding.

## 1. Three identities

| Identity | Proof | Where it lives | Authority |
| --- | --- | --- | --- |
| **Account** | Supabase email/password session | Supabase session storage (unchanged) | `business_members` role: owner, manager or staff |
| **Registered device** | Opaque device credential, issued once | Native: SecureStore, device-only Keychain class. Web preview: memory only. Server: salted SHA-256 only | Establishes the device's business. Never a business selector |
| **Employee** | 4–6 digit PIN entered on a registered device | Opaque employee session, client memory only. Server: salted hash only | Employee role (employee, manager or owner) and its permissions |

- A PIN is never Supabase authentication. No JWT is created.
- PIN login is not clock-in. Lock is not clock-out. Device registration is not employee login.
- There is no employee chooser. The registered device shows a universal PIN keypad, and the PIN identifies the employee without listing anyone.

## 2. Employee PINs

- **Format:** 4–6 digits, scrypt-hashed with a per-employee 16-byte salt and a 32-byte key. Plaintext is never stored, logged or returned.
- **Uniqueness:** an active PIN is unique within its business. This is enforced atomically by `m04_write_employee`:
  - It takes a per-business advisory lock.
  - It compares the active-PIN hash snapshot against what the server verified with scrypt.
  - It rechecks the account role and the hierarchy.
- **Matching:** if more than one employee matches a PIN, the unlock is refused.
- **Rate limiting:** applies per device, enforced on the server:
  - Each attempt is reserved with a conditional database update *before* scrypt runs, so concurrent attempts can't spend the same slot (`PIN_RETRY`).
  - Five failures lock the device for 15 minutes (`PIN_LOCKED`).
  - A verified success resets the counter.

## 3. Employee sessions

- **Credentials:** opaque random credentials, stored on the server as a salted hash. Sessions expire after 8 hours.
- **Every validation rechecks:**
  - The session is not expired or revoked.
  - Device, business and employee binding.
  - The device is not revoked.
  - The employee is active, and their record has not changed since the session was issued.
  - The PIN-transition timestamp, so any later PIN attempt on the device invalidates earlier sessions, including ones whose Lock request was lost.
- **Changes that revoke sessions:** any Team change to an employee (rename, role change, PIN reset, deactivation, reactivation) revokes their sessions in the same transaction.
- **Lock:**
  - Revokes the employee session, clears in-memory identity and returns to the PIN keypad. The device stays registered.
  - Backgrounding the app locks too.
  - If the server lock can't be confirmed, the app keeps a retry handle and stays gated.

## 4. Registration and secure storage

- **Registration** (`POST /api/devices`):
  - Requires an owner or manager account.
  - The business comes from verified membership.
  - The raw credential is returned only at issuance and stored only in SecureStore.
- **Shared-device marker:** registering also persists a marker in SecureStore (`zude.shared-device.v1`). It is not a secret; it records that this installation is a shared device.
  - It is written *before* the credential is issued.
  - It survives sign-out and restarts.
  - It is also recorded when a malformed credential is found, because such a credential proves the installation was registered.
- **Vault states:** `opening → ready | unavailable`.
  - A malformed stored credential is deleted securely, and the app returns to registration.
  - A SecureStore read or delete failure gives `unavailable`: fail closed, Retry Secure Storage, no plaintext or AsyncStorage fallback.
  - Every deletion is verified by reading the value back.

## 5. Shared-device authorization rule

The critical M04 rule.

**A. Account / setup mode** applies when the installation is not a shared device. The signed-in account's `business_members` role authorizes management, as before. This is how an owner creates the first employees and registers the first iPad, so there is no setup deadlock.

**B. Shared-device mode** applies once registered. The workspace can only be reached through an employee PIN. Every Team, Registered Devices and service-catalog management request then carries two extra headers:

- `x-zude-device`: the device credential.
- `x-zude-employee-session`: the employee session.

The server (`server/operational-authority.ts`) verifies both and authorizes on the **weaker** of:
- the account role, and
- the PIN-verified employee's role (`team:manage-managers` = owner, `team:manage-employees` = manager, no permissions = staff).

So:

- An employee PIN on an owner-signed-in iPad has no Team, device or catalog management (`403 EMPLOYEE_FORBIDDEN`).
- A manager PIN gets manager capabilities. An owner PIN gets owner capabilities, capped by the account role.
- A device header without a valid session, or an expired, locked, revoked or deactivated identity, fails closed (`401 IDENTITY_UNAUTHORIZED`). A revoked device gives `401 DEVICE_REVOKED`. A device from another business gives `403 DEVICE_BUSINESS_MISMATCH`.
- Client-declared roles, permissions or employee IDs are rejected by body allow-lists or ignored. Authority comes only from server-verified credentials.
- The native transport refuses to send management requests while a shared device is locked (`IDENTITY_REQUIRED`).
- Header injection can't replace `Authorization` or the business header.

**Leaving shared-device mode needs proof of account authority.** On a shared iPad the account session is restored silently, so its presence does not prove an owner is present. These actions require a recent (10-minute) interactive password sign-in on the device:

- Forget This Device. A PIN-unlocked employee with `devices:manage` may also do this.
- Re-registering the device.
- Stop Shared-Device Use.

A confirmed **Sign Out of ZUDE** is available on the gated screens, so an owner or manager can re-prove authority. Losing the credential (forget, revocation or corruption) never re-opens the account workspace, and neither does restarting the app.

**Accepted limitations:**
- Sign Out on a kiosk lets anyone sign it out. That's denial of service only; signing back in needs the password.
- Someone who extracts the account session token from the device has the account itself. That is outside M04's PIN boundary; respond by revoking the account's sessions or changing its password.

## 6. Forget This Device (local only)

- Requires a confirmation step.
- Requires step-up or a `devices:manage` employee, as above.
- Ends the employee session (best effort), clears identity and deletes the local credential with verification.
- Returns to registration while the iPad stays a shared device.
- Never claims to revoke the server device; the confirmation text says so.
- If deletion fails, the device remains registered and the message says it was not forgotten.

## 7. Automatic recovery: `DEVICE_INVALID` / `DEVICE_REVOKED`

Only `401 DEVICE_INVALID` (malformed, unknown or wrong-secret credential, deliberately indistinguishable) or `401 DEVICE_REVOKED` (disclosed only after the secret verifies) forgets the local credential. They can arrive from a PIN, Lock or management request.

Nothing else clears a registration:
- `PIN_INVALID`, `PIN_LOCKED`, `PIN_RETRY`
- `IDENTITY_UNAUTHORIZED`, and 401s without a code
- Network errors, timeouts, and 5xx responses, even if they carry a device code
- Session races

A stale rejection is ignored when it concerns a credential that is no longer stored, or a session that is no longer current. A late PIN success after forget or re-registration is revoked instead of restored.

Revoking a device in Registered Devices never touches that iPad's local credential directly. The revoked iPad discovers `DEVICE_REVOKED` on its next device-authenticated request and runs this recovery itself. That includes revoking the iPad you're using: its own directory refresh is that next request.

## 8. Team

Destination: Manage → Team (owner/manager). Uses `/api/team`.

- **Directory:** Active and Inactive views, showing name, role and state. Includes loading, error with retry, and empty states.
- **Add Employee:** display name, role, PIN and Confirm PIN.
  - The confirmation is checked on the device, and the server stays authoritative.
  - PIN fields are secure, numeric and never autofilled. They are cleared the moment a request is submitted, whatever the outcome.
- **Employee actions:** edit name, permitted role change, Reset PIN, and Deactivate (confirmed).
- **Inactive employees:** Reactivate with a **new** PIN through the existing `PATCH /api/team/:id {isActive:true, pin}` contract. The old PIN is never restored, and records are never deleted.
- **Hierarchy** (server-enforced, mirrored in the UI):
  - An owner manages employees and managers.
  - A manager manages ordinary employees only, with no controls on manager or owner rows.
  - Staff have no Team access.
  - On a shared iPad, the PIN-verified employee narrows all of this (§5).
- **Owner role:** "Owner" is not offered as a role in the native UI, and owner-role employees' roles are read-only there. Server owner-role semantics are unchanged; this is an open product decision.
- **Safety:** mutations refresh the directory and block duplicate submissions. Error text comes from client-owned messages keyed by server codes.

## 9. Registered Devices

Destination: Business → Registered Devices (owner/manager). Uses `GET /api/devices` and `POST /api/devices/:id` with body `{}`.

- **Directory:** safe fields only (name, Active/Revoked, registered time, last used), in the business's timezone.
  - Credential, hash and salt never enter client state.
  - The wrapper rejects responses for another business, at both response and row level.
- **Revoke Device:** destructive, with a confirmation that explains the device won't unlock with PINs and must be registered again. Duplicate submissions are blocked, and the directory refreshes afterwards.
- **Revoked devices:** stay listed as history with their revocation time and can't be revoked again in the UI. Server revocation is idempotent and keeps the first `revoked_at`/`revoked_by_user_id`.
- The app never infers which row is the current iPad from names.

## 10. Tenant isolation

- **Business context:** every M04 endpoint derives the business from verified membership (`resolveBusinessContext`). Device endpoints derive it from the verified device record.
- **Cross-business access:**
  - Employee mutations, PIN resets and device revocations from another business return 404 and never write.
  - A device from another business can't authorize this one.
- **Client checks:** native wrappers reject cross-business responses.
- **Service role:** the service-role client is used only on the server, after authorization.
- **Database:** RLS stays enabled with no anon or authenticated privileges on `employees`, `zude_devices` or `employee_sessions`.

## 11. Endpoints

| Endpoint | Authority |
| --- | --- |
| `GET/POST /api/team`, `PATCH /api/team/:id`, `POST /api/team/:id/pin` | Account owner/manager. Narrowed by the PIN-verified employee on a shared device |
| `GET/POST /api/devices`, `POST /api/devices/:id` | Same, with `devices:manage` |
| `GET /api/services/catalog` (canManage), `POST/PATCH /api/services` | Same rule for catalog management. Reads are open to members |
| `POST /api/device/pin`, `/api/employee-session/validate`, `/api/employee-session/lock` | `Authorization: ZudeDevice <credential>`. Business selectors are rejected |

CORS explicitly allows the two shared-device headers; there is no wildcard.

## 12. Remaining for M05 and later

- Time Clock, My Time, breaks, timesheets, corrections and reports are not implemented.
- Future M05/M06 employee-scoped handlers must use `employeeIdentity()`/`authorizedEmployee()`.
- Appointments and customers remain open to any member, and an employee may use them, as in M03.
- **Product decision:** whether an owner may create or assign owner-role employees.

## 13. Requires physical-iPad verification

- SecureStore and Keychain persistence across app restarts.
- Backgrounding and Lock.
- Lockout timing.
- Revoking the current iPad, then automatic recovery, then re-registration.
- The sign-out step-up path.
- Readable layout at 1024×768.

Automated tests use synthetic fixtures and do not prove device Keychain behavior.
