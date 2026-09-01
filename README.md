# AssppWeb

A web-based tool for acquiring and installing iOS apps outside the App Store. Authenticate with your Apple ID, search for apps, acquire licenses, and install IPAs directly to your device.

![preview](./resources/preview.png)

## Authentication and Wisp Architecture

AssppWeb uses a hybrid architecture. Apple account authentication is performed by a server-side `ipatool` SAP helper, while purchase, download-info, version lookup, and other non-login Apple protocol requests continue to run in the browser and use the Wisp TCP relay where required.

During sign-in and reauthentication, the data flow is:

```text
Browser -> AssppWeb backend -> stdin -> asspp-sap-auth -> ipatool -> Apple
```

The AssppWeb backend therefore **can see the Apple ID, password, optional 2FA verification code, and legacy cookies while an authentication request is being processed**. The helper uses an in-memory keychain and cookie jar and communicates with the backend through per-process stdin/stdout. AssppWeb does not add a server-side plaintext credential store, and authentication code must not log passwords, verification codes, password tokens, or cookie contents.

The existing client account model is unchanged: if the frontend saves an account/password in IndexedDB, that behavior and secret lifetime remain controlled by the existing client logic. This migration does not create an additional backend credential copy on disk.

> **⚠️ Important Security Notice:** There are no official Asspp Web instances. Because the server now participates directly in Apple authentication, a server administrator is technically capable of observing credentials submitted during login. Use a self-hosted instance or an instance operated by someone you trust. A malicious host can also serve modified frontend code. Always use HTTPS and verify that you are connecting to the intended service.
>
> Apple authentication is disabled by default unless `ACCESS_PASSWORD` is configured. `UNSAFE_ALLOW_PUBLIC_APPLE_AUTH=true` can explicitly override this guard for deployments that intentionally accept the risk of unauthenticated public SAP requests.

**恳请所有转发项目的博主对自己的受众进行网络安全技术科普。要有哪个不拎清的大头儿子搞出事情来都够我们喝一壶的。**

## Quick Start

### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Lakr233/AssppWeb&apiTokenTmpl=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22write%22%7D%2C%7B%22key%22%3A%22containers%22%2C%22type%22%3A%22write%22%7D%2C%7B%22key%22%3A%22cloudchamber%22%2C%22type%22%3A%22write%22%7D%5D&apiTokenName=AssppWeb%20Deploy)

This uses Cloudflare Workers + Containers with the published image `ghcr.io/lakr233/assppweb:latest`.

Requirements:

- Cloudflare Workers **Paid** plan (Containers are not available on Free).
- Deploy/build token with:
  - `Workers Scripts Edit`
  - `Containers Edit`
  - `Cloudchamber Edit`

If your build log fails at `Deploy a container application` with `Unauthorized`, your build token is missing required Containers/Cloudchamber permissions.

### Deploy to Railway

<details>
<summary>Click to show Railway deployment instructions</summary>

1. Go to [railway.com/new/image](https://railway.com/new/image) → enter `ghcr.io/lakr233/assppweb:latest`
2. In service **Settings**, set **Healthcheck Path** to `/api/settings` and deploy
3. Right-click the service → **Attach volume** → mount path: `/data`
4. In **Variables**, set `DATA_DIR` = `/data` and deploy
5. In **Settings** → **Networking**, generate a public domain or add a custom domain

**Notes**

- The free trial works but has limitations (volume expiry, network restrictions). **Hobby** plan ($5/month) or above is recommended for reliable use.
- Enable [**Serverless**](https://docs.railway.com/deployments/serverless) in service settings to scale down to zero during idle periods
- Railway [auto-updates](https://docs.railway.com/deployments/image-auto-updates) `:latest` images from GHCR — new releases will be deployed automatically within a few hours
- Configure `ACCESS_PASSWORD` before enabling Apple account authentication on a public Railway domain.

> **⚠️ Custom domain with Cloudflare:** Railway's Cloudflare integration creates DNS records with Proxy enabled (orange cloud) by default. After authorizing, go to Cloudflare DNS settings and switch the CNAME record to **DNS only** (gray cloud) — Railway handles TLS automatically. If you keep Cloudflare Proxy on, you must set SSL/TLS mode to **Full** (not Flexible or Full Strict), otherwise you'll get an infinite redirect loop. See [Railway docs](https://docs.railway.com/networking/troubleshooting/ssl#err_too_many_redirects).

</details>

### Self-Host with Docker Compose

<details>
<summary>Click to show manual Docker Compose setup instructions</summary>

**Setup Docker Compose**

```bash
curl -O https://raw.githubusercontent.com/Lakr233/AssppWeb/main/compose.yml
docker compose up -d
```

The checked-in `compose.yml` uses the published image `ghcr.io/lakr233/assppweb:latest`; it does **not** contain a `build:` section and therefore does not build the source tree you currently have checked out. To verify or run local source changes, build the repository `Dockerfile` explicitly (for example, `docker build -t assppweb-local .`) and run that image instead of treating `docker compose up --build` as a source build.

**Environment Variables**

| Variable                                    | Default                          | Description                                                                                 |
| ------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `PORT`                                      | `8080`                           | Server listen port                                                                          |
| `DATA_DIR`                                  | `./data`                         | Directory for storing compiled IPAs                                                         |
| `PUBLIC_BASE_URL`                           | _(auto-detect)_                  | Public URL for generating install manifests (e.g. `https://asspp.example.com`)              |
| `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT` | `false`                          | Disable HTTPS redirect (see warning below)                                                  |
| `AUTO_CLEANUP_DAYS`                         | `0`                              | Automatically delete cached IPA files older than specified days (0 to disable)              |
| `AUTO_CLEANUP_MAX_MB`                       | `0`                              | Automatically delete oldest cached files when size exceeds this MB limit (0 to disable)     |
| `MAX_DOWNLOAD_MB`                           | `0`                              | Reject downloads exceeding this size in MB to prevent out-of-memory errors (0 to disable)   |
| `DOWNLOAD_THREADS`                          | `8`                              | Number of parallel threads for IPA downloads (1–32)                                         |
| `ACCESS_PASSWORD`                           | _(none)_                         | Require a password to access the web UI and API; required for Apple authentication by default |
| `UNSAFE_ALLOW_PUBLIC_APPLE_AUTH`            | `false`                          | Explicitly allow `/api/apple/authenticate` without `ACCESS_PASSWORD` (unsafe for public instances) |
| `SAP_AUTH_HELPER_PATH`                      | `/usr/local/bin/asspp-sap-auth` | Path to the local ipatool SAP authentication helper                                         |
| `SAP_AUTH_TIMEOUT_MS`                       | `120000`                         | Maximum runtime for one SAP helper authentication process                                   |
| `SAP_AUTH_MAX_CONCURRENCY`                  | `4`                              | Maximum number of SAP helper processes allowed to run concurrently; excess requests receive 503 |

**Reverse Proxy (Required for Install Apps on iOS)**

iOS requires HTTPS for `itms-services://` install links. You must put AssppWeb behind a reverse proxy with a valid TLS certificate.

> **⚠️ Redirect loop (`ERR_TOO_MANY_REDIRECTS`)?** Some reverse proxies (e.g. NAS built-in proxies) always send `X-Forwarded-Proto: http` even when the client connected via HTTPS, causing an infinite redirect loop. If you cannot configure your proxy to send the correct header, set `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT=true` as a last resort. **This disables the HTTP→HTTPS redirect — you must ensure your proxy enforces HTTPS externally.**

The following is an example Caddyfile configuration:

```text
asspp.example.com { reverse_proxy 127.0.0.1:8080 }
```

**⚠️ Make Sure WebSocket Works**

AssppWeb still uses the Wisp protocol over WebSocket (`/wisp/`) for non-authentication Apple protocol traffic such as purchase, download information, and version operations. Ensure your reverse proxy or CDN is configured to allow WebSocket connections. The SAP login migration does **not** make Wisp obsolete.

</details>

## Security Recommendations

**Credential trust boundary**

Apple ID credentials and 2FA codes pass through the AssppWeb backend during authentication and are then sent to the local SAP helper over stdin. Do not put these values in URLs, logs, monitoring labels, or exception context. Prefer self-hosting or a trusted administrator.

**SAP authentication resource limits**

Each Apple authentication request starts a native helper process. The backend limits concurrent helpers with `SAP_AUTH_MAX_CONCURRENCY` (default `4`), rejects excess requests instead of maintaining an unbounded queue, and terminates an in-flight helper if the HTTP client disconnects. Keep `ACCESS_PASSWORD` enabled on public instances unless you intentionally opt in with `UNSAFE_ALLOW_PUBLIC_APPLE_AUTH=true`.

**DDoS Protection**

IPA files can be hundreds of megabytes. If your instance is publicly accessible, put it behind a CDN like Cloudflare to absorb bandwidth and prevent abuse.

## License

MIT License. See [LICENSE](LICENSE) for details.

## 🥰 Acknowledgments

For projects that was stolen and used heavily:

- [ipatool](https://github.com/majd/ipatool)
- [Asspp](https://github.com/Lakr233/Asspp)

For friends who helped with testing and feedback:

- [@lbr77](https://github.com/lbr77)
- [@akinazuki](https://github.com/akinazuki)

<img src="./Artworks/fable5.jpg" alt="Fable 5 Verified" width="240">