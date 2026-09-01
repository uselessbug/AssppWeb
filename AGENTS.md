# Agent Instructions for AssppWeb

## TypeScript Code Style

- **Indentation**: 2 spaces
- **Semicolons**: Required
- **Quotes**: Double quotes for strings
- **Naming**: PascalCase for types/interfaces, camelCase for variables/functions

## Project Structure

- `backend/` — Node.js/Express server (TypeScript, ESM)
- `frontend/` — React SPA (TypeScript, Vite, Tailwind CSS)
- `sap-auth/` — Go helper for server-side ipatool SAP authentication
- `e2e/` — historical Playwright E2E location; this directory is not present in the current repository baseline
- `references/ApplePackage/` — Swift reference implementation (source of truth)
- Multi-stage Docker build (single container serves frontend/backend and includes the SAP helper)

## Architecture — Authentication and Wisp Boundaries

Apple account authentication is server-side. The server is still a constrained Wisp TCP relay for non-authentication Apple protocol traffic, but it is no longer correct to say that the server never sees Apple credentials.

```
┌─ Browser (Client) ─────────────────────────────────┐
│  Credentials (IndexedDB): email, password, cookies, │
│    passwordToken, DSID, deviceIdentifier, pod       │
│                                                      │
│  Authentication:                                    │
│    POST /api/apple/authenticate                      │
│      → AssppWeb backend                              │
│      → stdin to local asspp-sap-auth helper          │
│      → ipatool SAP → Apple                           │
│                                                      │
│  Non-auth Apple Protocol (libcurl.js WASM):          │
│    Purchase, download info, version listing/lookup,  │
│    redownload fallback, and related Apple requests   │
│    continue through Wisp where required              │
└──────────────────────┬───────────────────────────────┘
                       │ Wisp-multiplexed TCP for non-auth flows
┌─ Server ─────────────┴───────────────────────────────┐
│  Wisp server (@mercuryworkshop/wisp-js) on /wisp/    │
│  → constrained TCP relay for browser Apple requests  │
│                                                      │
│  SAP auth route + helper process:                    │
│    - Backend receives Apple ID/password/optional 2FA │
│    - Sanitizes legacy cookies and validates device ID │
│    - Sends one JSON request to helper stdin           │
│    - Helper uses in-memory keychain/cookie jar        │
│    - Helper returns one JSON response on stdout       │
│                                                      │
│  Bag proxy: GET /api/bag?guid=<id>                   │
│    - Fetches init.itunes.apple.com/bag.xml via HTTPS │
│    - Returns public Apple service URLs                │
│                                                      │
│  After client obtains download info:                 │
│    Client POSTs: { downloadURL, sinfs, metadata }    │
│    - Server downloads IPA from CDN, injects SINFs +  │
│      iTunesMetadata, stores compiled IPA, serves it   │
└──────────────────────────────────────────────────────┘
```

**Authentication security boundary**: During login/reauthentication the AssppWeb backend and local SAP helper can see the Apple ID, password, optional 2FA verification code, and session cookies supplied to the helper. These secrets must never be logged. The helper uses process-local stdin/stdout, an in-memory keychain, and an in-memory cookie jar; do not add a server-side plaintext credential store.

The existing frontend Account/IndexedDB persistence model is unchanged. In particular, the existing client-side saved `password` behavior remains controlled by current frontend logic; this migration must not create an additional backend credential copy or extend secret lifetime unnecessarily.

**Wisp invariant**: Wisp is not obsolete. Purchase, download information, version listing/lookup, redownload fallback, and other non-login Apple protocol calls may still use `appleRequest()` + libcurl.js + Wisp. Do not remove those capabilities as part of authentication work.

## Authentication

- `frontend/src/apple/authenticate.ts` calls the protected backend endpoint `POST /api/apple/authenticate`; it does not perform Apple login through Wisp.
- The frontend must use the existing `authHeaders()` / `X-Access-Token` mechanism so `ACCESS_PASSWORD` continues to protect the endpoint.
- Apple IDs are not required to be email-shaped; require only a trimmed non-empty string.
- Frontend and backend both sanitize legacy cookies before they reach the helper. Cookie metadata includes an optional backward-compatible `hostOnly` flag; legacy cookies without it retain the previous domain-cookie interpretation.
- The backend passes auth input to the helper only through stdin and reads one JSON response from stdout. Do not put passwords or 2FA codes in URLs/query strings.
- The helper path is configurable with `SAP_AUTH_HELPER_PATH` (default `/usr/local/bin/asspp-sap-auth`) and timeout with `SAP_AUTH_TIMEOUT_MS`.
- The helper must make at most **one** ipatool login call per process. Do not reintroduce helper-side 3x/5x credential retries.
- Reauthentication owns the only automatic fallback: one cached-session attempt, then at most one fresh-session attempt with `existingCookies = []`, and only when `/api/apple/authenticate` explicitly classifies the result as an Apple `authentication` failure. Infrastructure/network/access-middleware failures are never eligible for this retry.
- A 2FA challenge does not itself trigger an automatic fresh helper call. The subsequent user verification-code submission is always a fresh authentication request with `existingCookies = []`.
- Do not automatically loop after a failed fresh authentication or failed 2FA submission.
- Successful auth responses must include `passwordToken` and `directoryServicesIdentifier` before becoming an Account.

## Reference Implementation

The Swift reference at `references/ApplePackage/` is the source of truth for Apple protocol behavior:

- Field mappings (iTunes API → Software type) use Swift `CodingKeys`
- Bag endpoint, pod routing, purchase/download/version behavior, error codes
- Server-side authentication follows the pinned ipatool SAP behavior in `sap-auth/`
- Always consult the reference when making protocol changes, while preserving newer target-repository fixes

### iTunes API Field Mapping

The backend (`backend/src/routes/search.ts`) maps raw iTunes API fields to our `Software` type, matching the Swift CodingKeys in `references/ApplePackage/Sources/ApplePackage/Models/Software.swift`:

| iTunes Field                | Software Field |
| --------------------------- | -------------- |
| `trackId`                   | `id`           |
| `bundleId`                  | `bundleID`     |
| `trackName`                 | `name`         |
| `artworkUrl512`             | `artworkUrl`   |
| `currentVersionReleaseDate` | `releaseDate`  |

All other fields (`version`, `price`, `artistName`, `sellerName`, `description`, `averageUserRating`, `userRatingCount`, `screenshotUrls`, `minimumOsVersion`, `fileSizeBytes`, `releaseNotes`, `formattedPrice`, `primaryGenreName`) keep their original names.

The backend also extracts the `results` array from the iTunes wrapper `{ resultCount, results }` before sending to the frontend.

## Per-Account Device Identifiers

Device identifiers are **per-account**, not global:

- Generated as 12 lowercase hex chars (6 bytes) at account creation via `generateDeviceId()`
- The first byte is normalized to unicast (`multicast bit = 0`) and locally administered (`local bit = 1`) for SAP MAC/hardware identifier semantics
- `normalizeDeviceId()` trims input, removes allowed `:`/space separators, lowercases it, and applies the same first-byte normalization only to valid 12-hex values
- Invalid legacy values remain detectably invalid; reauthentication replaces them with a newly generated valid Device ID
- Editable during login, immutable after authentication
- Stored in IndexedDB on the `Account` object as `deviceIdentifier`
- Passed to Apple protocol calls that require it
- After successful SAP authentication, persist the helper-returned `deviceIdentifier`

## Pod-Based Host Routing

After authentication, Apple returns a `pod` value:

- Store API: `p{pod}-buy.itunes.apple.com` (default: `p25-buy.itunes.apple.com`)
- Purchase API: `p{pod}-buy.itunes.apple.com` (default: `buy.itunes.apple.com`)
- Pod is stored on the Account object and used for all subsequent API calls
- Functions: `storeAPIHost(pod?)` and `purchaseAPIHost(pod?)` in `frontend/src/apple/config.ts`

Apple storefront values may be plain numeric IDs (`143463`) or descriptors (`143463-2,34`). Country mapping/display/filtering must use only the leading numeric storefront ID while preserving the original Account `store` value. Purchase requests send the stored storefront value verbatim, matching ipatool v2.4.0. Do not append another suffix to a complete descriptor.

## Dynamic Host Validation (Backend)

The Wisp server validates target hosts via `hostname_whitelist` in `backend/src/services/wsProxy.ts`:

- `auth.itunes.apple.com` — legacy/bag-resolved auth endpoint; keep the existing capability unless separately proven unused by all non-auth flows
- `buy.itunes.apple.com` — purchase endpoint
- `init.itunes.apple.com` — bag endpoint
- `/^p\d+-buy\.itunes\.apple\.com$/` — pod-based hosts
- Existing explicitly allowed download-dispatch host(s) must remain available for current redownload behavior
- Port restricted to `443` only
- Direct IP targets blocked (`allow_direct_ip = false`)
- Loopback IP targets blocked (`allow_loopback_ips = false`)
- Private/reserved resolved IPs allowed (`allow_private_ips = true`) for Docker/OrbStack DNS translation while hostname allowlist remains the primary control

Do not broaden this to arbitrary `*.itunes.apple.com`.

## Bag Proxy (Backend)

The backend proxies the bag endpoint via `GET /api/bag?guid=<deviceId>` using Node.js native HTTPS. It sends Configurator-compatible request headers (`User-Agent`, `Accept: application/xml`). The bag response is public data (Apple service URLs). See `backend/src/routes/bag.ts`.

## Backend

- Express + `@mercuryworkshop/wisp-js` for HTTP and Wisp proxy
- ESM modules (`"type": "module"` in package.json)
- `tsx` for development, `tsc` for production build
- SINF injector also handles optional `iTunesMetadata.plist` injection at IPA root
- Bag proxy for `init.itunes.apple.com`
- `POST /api/apple/authenticate` is mounted behind the existing `/api` access middleware
- `backend/src/services/sapAuth.ts` spawns the local helper, applies timeout/output bounds, and must not expose raw helper stderr or request secrets
- Backend/helper logs must never contain Apple passwords, 2FA verification codes, password tokens, or cookie contents

### Backend Shared Utilities

- `backend/src/utils/route.ts` — shared Express route helpers (`getIdParam`, `requireAccountHash`, `verifyTaskOwnership`)
- `backend/src/config.ts` — centralized constants (`MAX_DOWNLOAD_SIZE`, `DOWNLOAD_TIMEOUT_MS`, `BAG_TIMEOUT_MS`, `BAG_MAX_BYTES`, `MIN_ACCOUNT_HASH_LENGTH`) and env-var config (`disableHttpsRedirect` via `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT`); SAP helper configuration belongs here as well

## Frontend

- React 19, React Router 7, Zustand for state
- Tailwind CSS 4 for styling
- Vite for build tooling
- IndexedDB for credential storage (via `idb`); the SAP migration does not expand the existing client persistence behavior
- `libcurl.js` (WASM) for browser-side TLS 1.3 via Mbed TLS on non-auth Apple protocol paths — connects through Wisp protocol
- `appleRequest()` in `frontend/src/apple/request.ts` wraps `libcurl.fetch` for non-login Apple API calls and forces HTTP/1.1 (`_libcurl_http_version: 1.1`)
- Authentication (`frontend/src/apple/authenticate.ts`) posts sanitized auth input to the backend SAP route using existing access headers
- Plist build/parse (`frontend/src/apple/plist.ts`) uses native XML builder and browser-native `DOMParser`
- Cookie helper (`frontend/src/apple/cookies.ts`) — `extractAndMergeCookies(rawHeaders, existingCookies, originHost?)` remains shared by non-auth Apple protocol files and preserves host-only scope when the response host is known

### Frontend Shared Components (`components/common/`)

Before creating a new reusable UI primitive, check `frontend/src/components/common/` and prefer an existing component when it fits. Keep shared components focused on cross-feature patterns rather than feature-specific behavior.

Current shared components include:

- **Alert** — status and feedback messages
- **AppIcon** — app artwork with size variants and fallback rendering
- **Badge** — compact status pills
- **ConfirmModal** — reusable confirmation dialogs built on the shared modal pattern
- **CountrySelect** — grouped country/region selector
- **EmptyState** — standardized empty-list and no-result states
- **GlobalDownloadNotifier** — app-wide download notifications
- **LoadingState** — standardized page/section loading state
- **Modal** — general dialog overlay and container
- **ProgressBar** — download/progress visualization
- **Spinner** — compact inline loading indicator
- **ToastContainer** — global toast presentation
- **icons** — shared navigation and theme SVG icons

Treat this list as descriptive rather than exhaustive: check the directory itself before introducing new shared UI code.

### Frontend Shared Utilities (`utils/`)

- `utils/error.ts` — `getErrorMessage(e, fallback)` for standardized catch-block error extraction
- `utils/crypto.ts` — AES-GCM encrypt/decrypt for account export/import
- `utils/account.ts` — `accountHash()`, `accountStoreCountry()`, `firstAccountCountry()`

### Import Ordering Convention

1. React / library imports (`useState`, `useNavigate`, `useTranslation`)
2. Layout components (`PageContainer`)
3. Common components (`AppIcon`, `Alert`, `Spinner`, `Modal`, `CountrySelect`)
4. Sibling components within the same feature folder (e.g., `DownloadItem` inside `Download/`)
5. Hooks / stores (`useAccounts`, `useSettingsStore`)
6. Apple protocol / API modules (`authenticate`, `purchaseApp`, `apiPost`)
7. Utilities (`accountHash`, `getErrorMessage`)
8. Config (`countryCodeMap`, `storeIdToCountry`)
9. Types (`type Software`)

**Enforcement**: Every PR must verify import ordering. Common mistakes:

- Putting hooks/stores before layout/common components
- Putting config before utilities
- Putting type imports in the middle instead of last

## Security Model

### Account Hash Is Public

`accountHash` is a SHA-256 of the account email. It is treated as **public, non-secret data** — it identifies which account owns a download but does not grant any privileged access. No authentication is bound to it.

### Authentication Trust Boundary

The server is now inside the Apple authentication trust boundary. During login/reauthentication the browser sends Apple ID/password, optional 2FA verification code, and sanitized cookies to the backend, which sends them through stdin to the local SAP helper. A server administrator can technically observe credentials during that operation. Prefer self-hosting or a trusted instance.

This visibility during authentication is not the same as persistence. Do not add backend plaintext persistence of Apple passwords/2FA codes/cookies/tokens, and do not log request bodies or helper stdin/stdout secrets. The helper's keychain and cookie jar remain memory-only.

### Trusted Sources

- **Apple API responses** (bag XML, iTunes search results, `customerMessage` fields) are treated as trusted content. No additional sanitization is applied beyond what React's text rendering provides (no `dangerouslySetInnerHTML`).
- **Apple CDN redirects** during IPA download are trusted. The initial URL is validated against the current Apple-host policy, and redirect targets from Apple's CDN infrastructure are followed. The response body is saved to disk — it is never reflected back to the requester.

### Browser as Security Boundary

Credentials stored in IndexedDB remain protected only by the browser's same-origin/XSS assumptions; encrypting them with a JS-held key would not solve XSS. However, the browser is **not** the sole authentication boundary anymore because credentials transit the backend and SAP helper during login.

The migration must not lengthen secret lifetime or create extra persistent copies. Existing IndexedDB Account/password behavior remains unchanged unless a separate task explicitly redesigns it.

### Backend Does Not Reflect Request Headers

The settings endpoint (`/api/settings`) must never reflect request headers (`x-forwarded-host`, `host`, etc.) in its response body. Use server-side values only (`config.*`, `process.uptime()`).

## Error Handling

- Early returns to reduce nesting
- `try/catch` for async operations
- Express error middleware for centralized handling
- Type-safe error responses
- SAP transport/runtime errors must not return stack traces or raw helper stderr

### Apple Protocol Error Codes

- `2034` / `2042` / `1008`: Authentication/session invalid — re-authentication required
- `customerMessage === 'Your password has changed.'`: Password token invalid even when `failureType` is absent
- `action.url` ending in `termsPage`: Terms acceptance required even when `failureType` is absent
- Purchase HTTP 500 is an already-owned fallback only after explicit plist failure semantics have been ruled out

## Testing

### Unit Tests

```bash
cd backend && npx vitest run    # Node environment
cd frontend && npx vitest run   # jsdom environment with fake-indexeddb
cd sap-auth && go test ./...
```

Also run production builds:

```bash
cd backend && npm run build
cd frontend && npm run build
cd sap-auth && go build
```

### E2E Tests (Playwright)

The current repository baseline does not contain the historical `e2e/` directory or `e2e/docker-test.sh`. Do not claim Playwright/Docker E2E passed unless those files exist and were actually executed.

If E2E coverage is restored, it must no longer assert that the backend never receives Apple credentials. Instead, it should verify the intended Browser → Backend → SAP helper authentication path and retain/strengthen backend log scanning so test Apple passwords, verification codes, password tokens, and cookie secrets never appear in logs.

WebSocket proxy E2E coverage should continue to validate Wisp for the non-auth Apple protocol paths that still depend on it.

### Test Account / Real-account Verification

Test credentials must come from environment variables or another non-committed secret source and must never be committed or printed.

The historical real-account verification that proved browser/Wisp authentication on 2026-02-22 is not evidence for the new SAP authentication architecture. Any real-account SAP verification must be explicitly re-run and reported separately from mocked/unit tests. Real-account logs must still be checked for Apple password, 2FA code, passwordToken, and cookie leakage.

## Deployment

The checked-in `compose.yml` uses `image: ghcr.io/lakr233/assppweb:latest` and has no `build:` section. Therefore:

```bash
docker compose up -d
```

runs the configured published image; adding `--build` does not build the current checkout. To build the current repository source, use the `Dockerfile` explicitly, for example:

```bash
docker build -t assppweb-local .
```

Single container images built from the repository Dockerfile serve both the Express backend and the Vite-built React SPA and include the native `asspp-sap-auth` helper. SPA routes are handled by serving `index.html` for all non-API paths. Docker builds the helper with CGO enabled and keeps `/data/packages`; the helper cache uses `/data/cache` through `XDG_CACHE_HOME`.

### Docker E2E Testing

The current repository baseline does not contain the historical Playwright service/script described by older documentation. If Docker E2E coverage is restored, it should build the complete image, verify `/usr/local/bin/asspp-sap-auth` exists and is native to the image architecture, verify `/data/cache` is usable without breaking `/data/packages`, confirm the healthcheck, and scan backend logs for credential/token/cookie leakage.

The existing GitHub Actions workflow builds native `linux/amd64` and `linux/arm64` images and merges digest-based outputs. Preserve this workflow unless a concrete build failure requires a minimal adaptation; never copy an amd64 helper into the arm64 image or reduce the image to one architecture.

## Interface Design System

### Intent

**Who**: Developers and power users managing Apple app downloads outside the App Store — sideloading IPAs, managing multiple Apple IDs, tracking licenses. Technical audience, likely running this alongside terminals or Xcode.

**Task**: Authenticate Apple accounts → search apps → acquire licenses → download/compile IPAs → install.

**Feel**: Calm, modern, utility-focused, and slightly Apple-like without imitating native UI. Prefer clear hierarchy, generous spacing, rounded surfaces, restrained depth, and direct feedback over dense or ornamental layouts.

### Design Tokens

- **Primary accent**: `blue-600` with `blue-700` hover/pressed states; use blue for primary actions, active navigation, focus, and progress
- **Backgrounds**: `gray-50` for the light page background and `gray-950` for the dark page background; primary surfaces use `white` / `gray-900`
- **Text**: `gray-900` / `white` for primary text, `gray-500`–`gray-600` / `gray-400` for secondary text, and `gray-400` / `gray-500` for tertiary text
- **Surface definition**: prefer subtle rings, dividers, and low-elevation shadows over heavy borders
- **Status colors**: keep semantic status colors muted and consistent; do not use saturated status colors as large decorative fills
- **Dark mode**: every persistent light surface, text role, border/ring, and interactive state must have an intentional dark counterpart

### Typography

- Use the existing system-font stack and the current Tailwind typography scale
- Default UI text is compact (`text-sm` / `text-base`) with `font-medium` or `font-semibold` for emphasis
- Page titles and major section headings establish hierarchy through size and weight rather than decorative styling
- Avoid unnecessary `font-bold` in ordinary body copy and controls unless an existing component establishes that pattern

### Spacing

- Preserve the existing 4px Tailwind spacing rhythm
- Favor generous page and card spacing over dense packing; common gaps are `gap-3`/`gap-4` and section spacing is typically `space-y-4`/`space-y-6`
- Keep responsive padding aligned with existing layout components instead of introducing one-off page gutters
- Prefer the existing `PageContainer` and layout primitives for page width and spacing decisions

### Depth & Surfaces

- Primary content surfaces are typically `bg-white dark:bg-gray-900` on the page background
- Large cards and grouped lists commonly use generous rounding such as `rounded-2xl` or `rounded-3xl`
- Use restrained depth such as `shadow-sm` and subtle rings like `ring-1 ring-black/5 dark:ring-white/10` when the current surrounding UI uses elevation
- Use dividers (`divide-*`) for grouped rows and list sections rather than boxing every child in its own border
- Avoid heavy drop shadows, thick borders, or stacked elevation levels; depth should remain subtle

### Layout

- Desktop: sticky sidebar (`w-[17rem]`) + scrollable main content
- Mobile: bottom navigation with safe-area padding
- Breakpoint: `md:` for sidebar ↔ bottom-navigation switching unless the existing component uses a more specific responsive rule
- Page structure: use `PageContainer` with a title and optional action, followed by feature content
- Keep primary actions visually clear but avoid filling every section with competing accent buttons

### Component Patterns

- **Primary actions**: blue fill, white text, `font-semibold`, and pill-like or strongly rounded geometry; current major CTAs commonly use `rounded-full`
- **Secondary actions**: neutral surface/border treatment with explicit hover and dark-mode states; match neighboring controls rather than inventing a new shape
- **Inputs/selects**: use the existing form-control radius, neutral border, and blue focus ring patterns already present in the feature being edited
- **Cards/grouped lists**: white/dark surface, generous radius, subtle ring and/or `shadow-sm`, with dividers for repeated rows
- **Badges/chips**: `rounded-full`, compact padding, muted background, and concise labels
- **Empty/loading states**: use the shared `EmptyState` and `LoadingState` components where applicable instead of reproducing layout and typography inline
- **Modals/confirmation**: use `Modal` and `ConfirmModal`; preserve their existing spacing, radius, overlay, and action hierarchy
- **Toasts/notifications**: use the shared toast/notifier infrastructure rather than feature-local fixed-position alerts
- **App icons/avatars**: reuse `AppIcon` for app artwork and follow existing circular avatar patterns for accounts
- **Navigation**: preserve existing sidebar/mobile active-state treatment and shared icons rather than introducing feature-specific navigation styling

### Consistency Rule

When modifying UI, treat the current implementation as the source of truth. Match adjacent screens and shared components before introducing a new token, radius, shadow, control shape, or layout pattern. If a recurring pattern is needed in multiple features, prefer extending or adding a shared component instead of duplicating styling.

## Frontend Cleanup Rules

These rules prevent the codebase from becoming messy after merging PRs. Enforce them on every change.

### `transition-colors` Usage Policy

**Problem**: `transition-colors` on static containers (cards, sections, alerts, badges) causes visible color flashing when the page loads in dark mode — the element briefly renders in light colors then transitions to dark.

**Rule**: Only use `transition-colors` on **interactive elements** that change color on user interaction:

- Buttons (hover state)
- Links (hover state)
- Form inputs and selects (focus state)
- Nav items (hover/active state)

**Never use `transition-colors` on**:

- Card containers (`bg-white dark:bg-gray-900 rounded-lg border ...`)
- Section wrappers (`<section>` with background)
- Alert/warning banners (use the `<Alert>` component)
- Badge pills
- ProgressBar tracks
- Modal containers
- AppIcon fallback containers
- Empty state placeholder containers

**Exception**: Layout chrome (Sidebar, MobileNav, MobileHeader, PageContainer) may keep `transition-colors duration-200` for smooth theme toggle animation, since these persist across navigations.

### Shared Icons

All navigation and theme icons live in `components/common/icons.tsx`. When Sidebar, MobileNav, or MobileHeader need icons, import from there. Never duplicate icon SVG components inline.

### Import Ordering Verification

Before merging any frontend PR, verify imports follow the convention in every changed file:

```
1. React / library imports
2. Layout components
3. Common components
4. Sibling components (same feature folder)
5. Hooks / stores
6. Apple protocol / API modules
7. Utilities
8. Config
9. Types
```

### Empty State Containers

Empty states (shown when a list has no items) use a consistent pattern:

- `border-2 border-dashed` (not solid border)
- `bg-gray-50 dark:bg-gray-900/30` background
- No `transition-colors` (removed to prevent dark mode flashing)
- Centered icon in a white circle, title, description, optional CTA button

### Dark Mode Color Pairings

Always pair light and dark variants consistently:

- **Primary text**: `text-gray-900 dark:text-white`
- **Secondary text**: `text-gray-600 dark:text-gray-400` or `text-gray-500 dark:text-gray-400`
- **Tertiary text**: `text-gray-400 dark:text-gray-500`
- **Card background**: `bg-white dark:bg-gray-900`
- **Page background**: `bg-gray-50 dark:bg-gray-950`
- **Card border**: `border-gray-200 dark:border-gray-800`
- **Input border**: `border-gray-300 dark:border-gray-700`

### Code Duplication Prevention

Before creating or duplicating a reusable UI pattern, inspect `components/common/` first. Extract a shared component when the same pattern is used across multiple features or when an existing shared primitive can be cleanly extended.

Current shared components include `Alert`, `AppIcon`, `Badge`, `ConfirmModal`, `CountrySelect`, `EmptyState`, `GlobalDownloadNotifier`, `LoadingState`, `Modal`, `ProgressBar`, `Spinner`, `ToastContainer`, and `icons`. Treat this list as a convenience snapshot, not the authoritative inventory; the directory itself is the source of truth.

### Authenticated API Downloads

**Problem**: Plain `<a href="/api/...">` tags and `window.open("/api/...")` make regular browser navigations that cannot carry custom HTTP headers. When `ACCESS_PASSWORD` is set, the `accessAuth` middleware requires an `X-Access-Token` header, so these requests fail with 401.

**Rule**: Never use `<a href>` or `window.open` for `/api/` endpoints that require authentication. Instead, use `fetch()` with `authHeaders()` from `api/client.ts`, then trigger a download via blob URL:

```tsx
const res = await fetch(url, { headers: authHeaders() });
const blob = await res.blob();
const blobUrl = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = blobUrl;
a.download = filename;
a.click();
URL.revokeObjectURL(blobUrl);
```

**Exceptions**: Routes that the backend explicitly skips auth for (`/auth/*`, `/install/*`) may use plain links — e.g., `itms-services://` install URLs are fine since `/install/*` is public.