export interface SapConfig {
  setupURL: string;
  certificateURL: string;
  version: number;
}

export interface AppleActionSigner {
  sign(input: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
}

export type BrowserSapSignerFactory = (
  config: SapConfig,
  hardwareId: Uint8Array,
) => Promise<AppleActionSigner>;

const SUPPORTED_SAP_VERSION = 200;

let browserSapSignerFactory: BrowserSapSignerFactory | undefined;

/**
 * Registers the browser implementation that executes Apple's SAP signer.
 *
 * The factory runs inside the frontend security boundary. It receives the SAP
 * setup endpoints and the per-account hardware identifier, while the backend
 * remains a blind Wisp relay and never receives credentials or signed login
 * payloads.
 */
export function registerBrowserSapSignerFactory(
  factory: BrowserSapSignerFactory,
): () => void {
  browserSapSignerFactory = factory;
  return () => {
    if (browserSapSignerFactory === factory) {
      browserSapSignerFactory = undefined;
    }
  };
}

export async function createBrowserSapSigner(
  config: SapConfig,
  deviceId: string,
): Promise<AppleActionSigner> {
  validateSapConfig(config);

  if (!browserSapSignerFactory) {
    throw new Error(
      "Browser SAP signer runtime is not available. A browser-side SAP runtime must be loaded before Apple authentication.",
    );
  }

  const hardwareId = deviceIdToHardwareId(deviceId);
  return browserSapSignerFactory(config, hardwareId);
}

export async function createAppleActionSignature(
  signer: AppleActionSigner,
  body: string,
): Promise<string> {
  const input = new TextEncoder().encode(body);
  const signature = await signer.sign(input);
  if (signature.length === 0) {
    throw new Error("Browser SAP signer returned an empty signature");
  }
  return base64FromBytes(signature);
}

export function normalizeSapDeviceId(value: string): string {
  const cleaned = value.replace(/[:\s-]/g, "").toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(cleaned)) {
    throw new Error("Device identifier must contain exactly 12 hexadecimal characters");
  }

  const first = parseInt(cleaned.slice(0, 2), 16);
  const normalizedFirst = ((first & 0xfc) | 0x02)
    .toString(16)
    .padStart(2, "0");
  return normalizedFirst + cleaned.slice(2);
}

function deviceIdToHardwareId(deviceId: string): Uint8Array {
  const normalized = normalizeSapDeviceId(deviceId);
  const hardwareId = new Uint8Array(6);
  for (let i = 0; i < hardwareId.length; i++) {
    hardwareId[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return hardwareId;
}

function validateSapConfig(config: SapConfig) {
  if (config.version !== SUPPORTED_SAP_VERSION) {
    throw new Error(`Unsupported SAP version ${config.version}`);
  }

  for (const [label, value] of [
    ["setup", config.setupURL],
    ["certificate", config.certificateURL],
  ] as const) {
    let endpoint: URL;
    try {
      endpoint = new URL(value);
    } catch {
      throw new Error(`Invalid SAP ${label} URL`);
    }
    if (endpoint.protocol !== "https:") {
      throw new Error(`SAP ${label} URL must use HTTPS`);
    }
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
