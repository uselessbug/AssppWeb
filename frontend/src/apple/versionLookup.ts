import { apiPost } from "../api/client";
import type { Account, Software, VersionMetadata } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from "./config";

interface RemoteVersionMetadata {
  displayVersion: string;
  releaseDate: string;
}

export class VersionLookupError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "VersionLookupError";
  }
}

export function isVersionLookupAuthExpired(error: unknown): boolean {
  return (
    error instanceof VersionLookupError &&
    (error.code === "2034" || error.code === "2042" || error.code === "1008")
  );
}

export async function getVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
): Promise<{
  metadata: VersionMetadata;
  updatedCookies: typeof account.cookies;
}> {
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: "",
      guid: deviceId,
      salableAdamId: app.id,
      [endpoint.externalVersionIdKey]: versionId,
    };

    const plistBody = buildPlist(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-apple-plist",
      "iCloud-DSID": account.directoryServicesIdentifier,
      "X-Dsid": account.directoryServicesIdentifier,
    };

    const response = await appleRequest({
      method: "POST",
      host: requestHost,
      path: requestPath,
      headers,
      body: plistBody,
      cookies,
    });

    cookies = extractAndMergeCookies(response.rawHeaders, cookies, requestHost);

    if (response.status === 302) {
      const location = response.headers["location"];
      if (!location) {
        throw new VersionLookupError("Failed to retrieve redirect location");
      }
      const url = new URL(location);
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      continue;
    }

    const dict = parsePlist(response.body) as Record<string, any>;
    const failureType =
      dict.failureType === undefined || dict.failureType === null
        ? undefined
        : String(dict.failureType);
    const customerMessage = dict.customerMessage as string | undefined;

    if (customerMessage === "Your password has changed.") {
      throw new VersionLookupError("Password token is expired", "2034");
    }

    if (
      failureType === "2034" ||
      failureType === "2042" ||
      failureType === "1008"
    ) {
      throw new VersionLookupError("Password token is expired", failureType);
    }

    if (failureType === RETRYABLE_FAILURE_TYPE && !triedRedownload) {
      triedRedownload = true;
      endpoint = redownloadEndpoint(deviceId);
      requestHost = endpoint.host;
      requestPath = endpoint.path;
      redirectAttempt = 0;
      continue;
    }

    if (failureType) {
      throw new VersionLookupError(
        customerMessage ?? `Version metadata lookup failed: ${failureType}`,
        failureType,
      );
    }

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (!songList || songList.length === 0) {
      throw new VersionLookupError("No items in response");
    }

    const downloadURL = songList[0].URL as string | undefined;
    if (!downloadURL) {
      throw new VersionLookupError("Missing download URL");
    }

    const metadata = await apiPost<RemoteVersionMetadata>(
      "/api/version-metadata",
      { downloadURL },
    );

    return { metadata, updatedCookies: cookies };
  }

  throw new VersionLookupError("Too many redirects");
}
