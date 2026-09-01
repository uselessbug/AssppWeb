import type { Account, Software } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from "./config";

export class VersionFinderError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "VersionFinderError";
  }
}

export function isVersionAuthExpired(error: unknown): boolean {
  return (
    error instanceof VersionFinderError &&
    (error.code === "2034" || error.code === "2042" || error.code === "1008")
  );
}

export async function listVersions(
  account: Account,
  app: Software,
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
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
        throw new VersionFinderError("Failed to retrieve redirect location");
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
      throw new VersionFinderError("Password token is expired", "2034");
    }

    if (
      failureType === "2034" ||
      failureType === "2042" ||
      failureType === "1008"
    ) {
      throw new VersionFinderError("Password token is expired", failureType);
    }

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (!songList || songList.length === 0) {
      if (failureType === RETRYABLE_FAILURE_TYPE && !triedRedownload) {
        triedRedownload = true;
        endpoint = redownloadEndpoint(deviceId);
        requestHost = endpoint.host;
        requestPath = endpoint.path;
        redirectAttempt = 0;
        continue;
      }

      if (failureType === "9610") {
        throw new VersionFinderError(
          "License required - purchase the app first",
          "9610",
        );
      }

      if (failureType) {
        throw new VersionFinderError(
          customerMessage ?? "No items in response",
          failureType,
        );
      }
      throw new VersionFinderError("No items in response");
    }

    const item = songList[0];
    const metadata = item.metadata as Record<string, any>;
    if (!metadata) {
      throw new VersionFinderError("Missing version identifiers");
    }

    const identifiers = metadata.softwareVersionExternalIdentifiers as any[];
    if (!identifiers) {
      throw new VersionFinderError("Missing version identifiers");
    }

    const versions = identifiers.map((id) => String(id)).reverse();
    if (versions.length === 0) {
      throw new VersionFinderError("No versions found");
    }

    return { versions, updatedCookies: cookies };
  }

  throw new VersionFinderError("Too many redirects");
}
