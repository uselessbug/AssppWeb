import type { Account, Cookie } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, defaultAuthURL } from "./bag";
import {
  createAppleActionSignature,
  createBrowserSapSigner,
  normalizeSapDeviceId,
} from "./sap";
import i18n from "../i18n";

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = "";
  let lastError: Error | null = null;
  const normalizedDeviceId = normalizeSapDeviceId(deviceId);

  const defaultAuthEndpoint = new URL(defaultAuthURL);
  defaultAuthEndpoint.searchParams.set("guid", normalizedDeviceId);
  let requestHost = defaultAuthEndpoint.hostname;
  let requestPath = `${defaultAuthEndpoint.pathname}${defaultAuthEndpoint.search}`;

  const bag = await fetchBag(normalizedDeviceId);
  const authEndpoint = new URL(bag.authURL);
  authEndpoint.searchParams.set("guid", normalizedDeviceId);
  requestHost = authEndpoint.hostname;
  requestPath = `${authEndpoint.pathname}${authEndpoint.search}`;

  const signer = bag.sapConfig
    ? await createBrowserSapSigner(bag.sapConfig, normalizedDeviceId)
    : undefined;

  let currentAttempt = 0;
  let redirectAttempt = 0;

  try {
    while (currentAttempt < 2 && redirectAttempt <= 3) {
      currentAttempt++;

      try {
        const body: Record<string, string> = {
          appleId: email,
          attempt: code ? "2" : "4",
          guid: normalizedDeviceId,
          password: code ? `${password}${code}` : password,
          rmp: "0",
          why: "signIn",
        };

        const plistBody = buildPlist(body);

        const headers: Record<string, string> = {
          "Content-Type": signer
            ? "application/x-www-form-urlencoded"
            : "application/x-apple-plist",
        };

        if (signer) {
          headers["X-Apple-ActionSignature"] = await createAppleActionSignature(
            signer,
            plistBody,
          );
        }

        const response = await appleRequest({
          method: "POST",
          host: requestHost,
          path: requestPath,
          headers,
          body: plistBody,
          cookies,
        });

        cookies = extractAndMergeCookies(response.rawHeaders, cookies);

        const storeHeader = response.headers["x-set-apple-store-front"];
        if (storeHeader) {
          const parts = storeHeader.split("-");
          if (parts[0]) {
            storeFront = parts[0];
          }
        }

        const podHeader = response.headers["pod"];
        const pod = podHeader || undefined;

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers["location"];
          if (!location) {
            throw new Error(i18n.t("errors.auth.redirectLocation"));
          }
          const url = new URL(location);
          requestHost = url.hostname;
          requestPath = url.pathname + url.search;
          currentAttempt--;
          redirectAttempt++;
          continue;
        }

        if (!response.body.trim()) {
          throw new Error(
            i18n.t("errors.auth.emptyBody", { status: response.status }),
          );
        }

        const dict = parsePlist(response.body) as Record<string, any>;

        if (
          dict.failureType === "" &&
          !code &&
          dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
        ) {
          throw new AuthenticationError(
            i18n.t("errors.auth.requiresVerification"),
            true,
          );
        }

        const failureMessage =
          (dict.dialog as Record<string, any>)?.explanation ??
          dict.customerMessage;

        const accountInfo = dict.accountInfo as Record<string, any>;
        if (!accountInfo) {
          throw new Error(
            failureMessage ?? i18n.t("errors.auth.missingAccountInfo"),
          );
        }

        const address = accountInfo.address as Record<string, any>;
        if (!address) {
          throw new Error(
            failureMessage ?? i18n.t("errors.auth.missingAddress"),
          );
        }

        const account: Account = {
          email,
          password,
          appleId: (accountInfo.appleId as string) ?? "",
          store: storeFront,
          firstName: (address.firstName as string) ?? "",
          lastName: (address.lastName as string) ?? "",
          passwordToken: (dict.passwordToken as string) ?? "",
          directoryServicesIdentifier: String(dict.dsPersonId ?? ""),
          cookies,
          deviceIdentifier: normalizedDeviceId,
          pod,
        };

        return account;
      } catch (e) {
        if (e instanceof AuthenticationError) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }

    throw lastError ?? new Error(i18n.t("errors.auth.unknownReason"));
  } finally {
    if (signer) {
      try {
        await signer.close();
      } catch (error) {
        console.warn(
          `[SAP] Failed to close browser signer: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
