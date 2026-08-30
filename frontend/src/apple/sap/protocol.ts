import { appleRequest } from "../request";
import { buildPlist, parsePlist } from "../plist";

const SETUP_CERTIFICATE_KEY = "sign-sap-setup-cert";
const SETUP_BUFFER_KEY = "sign-sap-setup-buffer";
const MAX_SETUP_BODY = 1 << 20;

export async function fetchSapCertificate(endpoint: string): Promise<Uint8Array> {
  const response = await sendSapRequest(endpoint, "GET");
  return plistData(response, SETUP_CERTIFICATE_KEY);
}

export async function exchangeSapSetup(
  endpoint: string,
  input: Uint8Array,
): Promise<Uint8Array> {
  if (input.length === 0) {
    throw new Error("SAP setup request buffer is empty");
  }

  const body = buildPlist({ [SETUP_BUFFER_KEY]: input });
  const response = await sendSapRequest(endpoint, "POST", body, {
    "Content-Type": "application/x-plist",
  });
  return plistData(response, SETUP_BUFFER_KEY);
}

async function sendSapRequest(
  endpoint: string,
  method: "GET" | "POST",
  body?: string,
  headers?: Record<string, string>,
): Promise<string> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("SAP setup endpoint must use HTTPS");
  }

  const response = await appleRequest({
    method,
    host: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers,
    body,
  });

  if (response.status !== 200) {
    throw new Error(
      `Apple SAP setup request returned HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }
  if (new TextEncoder().encode(response.body).length > MAX_SETUP_BODY) {
    throw new Error(`Apple SAP setup response exceeds ${MAX_SETUP_BODY} bytes`);
  }

  return response.body;
}

function plistData(document: string, key: string): Uint8Array {
  const values = parsePlist(document) as Record<string, unknown>;
  const value = values[key];
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new Error(`Apple plist is missing ${key}`);
  }
  return value;
}
