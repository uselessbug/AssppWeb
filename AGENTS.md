# Agent Instructions for AssppWeb

## TypeScript Code Style

- **Indentation**: 2 spaces
- **Semicolons**: Required
- **Quotes**: Double quotes for strings
- **Naming**: PascalCase for types/interfaces, camelCase for variables/functions

## Project Structure

- `backend/` — Node.js/Express server (TypeScript, ESM)
- `frontend/` — React SPA (TypeScript, Vite, Tailwind CSS)
- `e2e/` — Playwright E2E tests (pnpm)
- `references/ApplePackage/` — Swift reference implementation (source of truth)
- Multi-stage Docker build (single container serves both)

## Architecture — Zero-Trust

The server is a blind TCP proxy. It NEVER sees Apple credentials.

```
┌─ Browser (Client) ─────────────────────────────────┐
│  Credentials (IndexedDB): email, password, cookies, │
│    passwordToken, DSID, deviceIdentifier, pod       │
│                                                      │
│  Apple Protocol (libcurl.js WASM + Mbed TLS 1.3):   │
│    1. Bag fetch → backend proxy → resolve auth URL   │
│       (fallback to default auth endpoint if missing)  │
│    2. Authenticate → get token, cookies, pod         │
│    3. Purchase → acquire license                     │
│    4. Download info → get CDN URL + SINFs + metadata │
│    5. Version listing/lookup                         │
│                                                      │
│  TLS 1.3 encrypted via Wisp protocol over WebSocket  │
└──────────────────────┬───────────────────────────────┘
                       │ Wisp-multiplexed TCP (server cannot read)
┌─ Server (Wisp Proxy) ┴──────────────────────────────┐
│  Wisp server (@mercuryworkshop/wisp-js) on /wisp/    │
│  → multiplexed TCP relay (blind tunnel, no decrypt)  │
│                                                      │
│  Bag proxy: GET /api/bag?guid=<id>                   │
│    - Fetches init.itunes.apple.com/bag.xml via HTTPS │
│    - Returns public Apple service URLs (no creds)    │
│                                                      │
│  After client obtains download info:                 │
│    Client POSTs: { downloadURL, sinfs, metadata }    │
│    - downloadURL = Apple CDN (public, no auth)       │
│    - sinfs = DRM signatures (base64)                 │
│    - iTunesMetadata = app metadata plist (base64)    │
│                                                      │
│  Server downloads IPA from CDN, injects SINFs +      │
│  iTunesMetadata, stores compiled IPA, serves via     │
│  public install URL (itms-services manifest)         │
└──────────────────────────────────────────────────────┘
```

**Key invariant**: The server NEVER sees Apple credentials. All Apple TLS terminates at the browser via libcurl.js WASM (Mbed TLS 1.3). The server only receives public CDN URLs and non-secret metadata for IPA compilation. The bag proxy (`/api/bag`) only returns public Apple service URLs — no credentials pass through it.

## Reference Implementation

The Swift reference at `references/ApplePackage/` is the source of truth for Apple protocol behavior:

- Field mappings (iTunes API → Software type) use Swift `CodingKeys`
- Authentication flow, bag endpoint, pod routing, error codes
- Always consult the reference when making protocol changes

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

- Generated as 12 random hex chars (6 bytes) at account creation via `generateDeviceId()`
- Editable during login, immutable after authentication
- Stored in IndexedDB on the `Account` object as `deviceIdentifier`
- Passed to all Apple protocol calls (auth, purchase, download, version listing)

## Pod-Based Host Routing

After authentication, Apple returns a `pod` header:

- Store API: `p{pod}-buy.itunes.apple.com` (default: `p25-buy.itunes.apple.com`)
- Purchase API: `p{pod}-buy.itunes.apple.com` (default: `buy.itunes.apple.com`)
- Pod is stored on the Account object and used for all subsequent API calls
- Functions: `storeAPIHost(pod?)` and `purchaseAPIHost(pod?)` in `frontend/src/apple/config.ts`

## Dynamic Host Validation (Backend)

The Wisp server validates target hosts via `hostname_whitelist` in `backend/src/services/wsProxy.ts`:

- `auth.itunes.apple.com` — bag-resolved auth endpoint
- `buy.itunes.apple.com` — purchase endpoint
- `init.itunes.apple.com` — bag endpoint
- `/^p\d+-buy\.itunes\.apple\.com$/` — pod-based hosts
- Port restricted to `443` only
- Direct IP targets blocked (`allow_direct_ip = false`)
- Loopback IP targets blocked (`allow_loopback_ips = false`)
- Private/reserved resolved IPs allowed (`allow_private_ips = true`) for Docker/OrbStack DNS translation while hostname allowlist remains the primary control

## Bag Proxy (Backend)

The backend proxies the bag endpoint via `GET /api/bag?guid=<deviceId>` using Node.js native HTTPS. It sends Configurator-compatible request headers (`User-Agent`, `Accept: application/xml`). The bag response is public data (Apple service URLs) — no credentials are involved. See `backend/src/routes/bag.ts`.

## Backend

- Express + `@mercuryworkshop/wisp-js` for HTTP and Wisp proxy
- ESM modules (`"type": "module"` in package.json)
- `tsx` for development, `tsc` for production build
- SINF injector also handles optional `iTunesMetadata.plist` injection at IPA root
- Bag proxy for `init.itunes.apple.com`

### Backend Shared Utilities

- `backend/src/utils/route.ts` — shared Express route helpers (`getIdParam`, `requireAccountHash`, `verifyTaskOwnership`)
- `backend/src/config.ts` — centralized constants (`MAX_DOWNLOAD_SIZE`, `DOWNLOAD_TIMEOUT_MS`, `BAG_TIMEOUT_MS`, `BAG_MAX_BYTES`, `MIN_ACCOUNT_HASH_LENGTH`) and env-var config (`disableHttpsRedirect` via `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT`)

## Frontend

- React 19, React Router 7, Zustand for state
- Tailwind CSS 4 for styling
- Vite for build tooling
- IndexedDB for credential storage (via `idb`)
- `libcurl.js` (WASM) for browser-side TLS 1.3 via Mbed TLS — connects through Wisp protocol
- `appleRequest()` in `frontend/src/apple/request.ts` wraps `libcurl.fetch` for all Apple API calls and forces HTTP/1.1 (`_libcurl_http_version: 1.1`)
- Bag endpoint (`frontend/src/apple/bag.ts`) uses backend proxy (`/api/bag`) and falls back to `https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate` when `authenticateAccount` is missing or bag fetch fails
- Authentication (`frontend/src/apple/authenticate.ts`) resolves bag endpoint, then sets `guid` via URL query manipulation to avoid duplicate/malformed query parameters
- Plist build/parse (`frontend/src/apple/plist.ts`) uses native XML builder and browser-native `DOMParser`
- Cookie helper (`frontend/src/apple/cookies.ts`) — `extractAndMergeCookies(rawHeaders, existingCookies)` replaces the repeated extract-and-merge pattern across all Apple protocol files

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

`accountHash` is a SHA-256 of the account email. It is treated as **public, non-secret data** — it identifies which account owns a download but does not grant any privileged access. No authentication is bound to it. This is by design: the server is a blind proxy and does not manage user sessions.

### Trusted Sources

- **Apple API responses** (bag XML, iTunes search results, `customerMessage` fields) are treated as trusted content. No additional sanitization is applied beyond what React's text rendering provides (no `dangerouslySetInnerHTML`).
- **Apple CDN redirects** during IPA download are trusted. The initial URL is validated against `*.apple.com`, and redirect targets from Apple's CDN infrastructure (e.g., Akamai) are followed. The response body is saved to disk — it is never reflected back to the requester.

### Browser as Security Boundary

Credentials (passwords, `passwordToken`, cookies) stored in IndexedDB are protected by the browser's same-origin policy. Encrypting them at rest would be security theater — the decryption key would also live in JS. The threat model assumes the browser environment is trusted; if an attacker has XSS, they can exfiltrate credentials regardless of at-rest encryption.

### Backend Does Not Reflect Request Headers

The settings endpoint (`/api/settings`) must never reflect request headers (`x-forwarded-host`, `host`, etc.) in its response body. Use server-side values only (`config.*`, `process.uptime()`).

## Error Handling

- Early returns to reduce nesting
- `try/catch` for async operations
- Express error middleware for centralized handling
- Type-safe error responses

### Apple Protocol Error Codes

- `2034` / `2042`: Token expired — re-authentication required
- `customerMessage === 'Your password has changed.'`: Password token invalid
- `action.url` ending in `termsPage`: Terms acceptance required (throw with URL)

## Testing

### Unit Tests

```bash
cd backend && npx vitest run    # Node environment
cd frontend && npx vitest run   # jsdom environment with fake-indexeddb
```

### E2E Tests (Playwright)

```bash
cd e2e && pnpm test                            # Local (requires Docker on port 8080)
docker compose --profile test run --rm playwright  # Docker-based
bash e2e/docker-test.sh                        # Full: build + test + zero-trust verify
```

E2E tests import from `./fixtures` instead of `@playwright/test`.

WebSocket proxy tests use `location.host` to derive URLs dynamically, so they work both locally (`localhost:8080`) and in Docker (`asspp:8080`).

Real-account Docker verification (2026-02-22): authentication succeeds through Wisp, and backend logs contain only connection/stream metadata (no Apple credentials, password tokens, or cookies).

E2E tests cover:

- Wisp proxy (accepts /wisp/ WebSocket, rejects non-wisp paths)
- Add account flow (device ID field, randomize button, auth)
- Account detail (device ID, pod display)
- Settings page (no global device ID section)
- Search/lookup by bundle ID (verifies iTunes field mapping)
- Downloads API (iTunesMetadata support, backward compatibility)

### Test Account

Test credentials are stored in environment variables (`TEST_EMAIL`, `TEST_PASSWORD`, `TEST_DEVICE_ID`, `TEST_BUNDLE_ID`) and must never be committed to the repository.

## Deployment

```bash
docker compose up --build -d   # Builds and runs on port 8080
```

Single container serves both the Express backend and the Vite-built React SPA. SPA routes are handled by serving `index.html` for all non-API paths.

### Docker E2E Testing

The `compose.yml` includes a `playwright` service under the `test` profile:

```bash
docker compose --profile test run --rm playwright
```

This runs Playwright inside the official `mcr.microsoft.com/playwright` image, connecting to the app container via Docker internal DNS (`http://asspp:8080`). The `asspp` service has a healthcheck so the test container waits until the app is ready.

The `e2e/docker-test.sh` script automates the full flow: build, test, and verify zero-trust by scanning backend logs for credential leaks.

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
9. Types (always last)
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
