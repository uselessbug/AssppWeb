import type { Account, Cookie } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag } from "./bag";
import {
  createAppleActionSignature,
  createBrowserSapSigner,
  normalizeSapDeviceId,
} from "./sap";
import i18n from "../i18n";

const FAILURE_TYPE_INVALID_CREDENTIALS = "-5000";
const CUSTOMER_MESSAGE_BAD_LOGIN = "MZFinance.BadLogin.Configurator_message";
const CUSTOMER_MESSAGE_ACCOUNT_DISABLED = "Your account is disabled.";

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
  const normalizedDeviceId = normalizeSapDeviceId(deviceId);
  const cleanCode = code?.replace(/\s/g, "") ?? "";

  const bag = await fetchBag(normalizedDeviceId);
  if (!bag.sapConfig) {
    throw new AuthenticationError(
      "Apple bag did not provide the SAP configuration required for browser-side authentication",
    );
  }

  const initialEndpoint = new URL(bag.authURL);
  initialEndpoint.searchParams.set("guid", normalizedDeviceId);
  const signer = await createBrowserSapSigner(
    bag.sapConfig,
    normalizedDeviceId,
  );

  let redirectURL = "";

  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const endpoint = redirectURL ? new URL(redirectURL) : new URL(initialEndpoint);
      const requestAttempt = redirectURL ? 1 : attempt;

      const body: Record<string, string> = {
        appleId: email,
        attempt: String(requestAttempt),
        guid: normalizedDeviceId,
        password: `${password}${cleanCode}`,
        rmp: "0",
        why: "signIn",
      };
      const plistBody = buildPlist(body);
      const signature = await createAppleActionSignature(signer, plistBody);

      const response = await appleRequest({
        method: "POST",
        host: endpoint.hostname,
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Apple-ActionSignature": signature,
        },
        body: plistBody,
        cookies,
      });

      cookies = extractAndMergeCookies(response.rawHeaders, cookies);

      const storeHeader = response.headers["x-set-apple-store-front"];
      if (storeHeader) storeFront = storeHeader;
      const pod = response.headers["pod"] || undefined;

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (!location) {
          throw new AuthenticationError(i18n.t("errors.auth.redirectLocation"));
        }
        redirectURL = location;
        continue;
      }
      redirectURL = "";

      if (!response.body.trim()) {
        throw new AuthenticationError(
          i18n.t("errors.auth.emptyBody", { status: response.status }),
        );
      }

      const dict = parsePlist(response.body) as Record<string, any>;
      const failureType = String(dict.failureType ?? "");
      const customerMessage = String(dict.customerMessage ?? "");

      if (attempt === 1 && failureType === FAILURE_TYPE_INVALID_CREDENTIALS) {
        continue;
      }

      if (
        failureType === "" &&
        cleanCode === "" &&
        customerMessage === CUSTOMER_MESSAGE_BAD_LOGIN
      ) {
        throw new AuthenticationError(
          i18n.t("errors.auth.requiresVerification"),
          true,
        );
      }

      if (failureType === "" && customerMessage === CUSTOMER_MESSAGE_ACCOUNT_DISABLED) {
        throw new AuthenticationError(customerMessage);
      }

      if (failureType !== "") {
        throw new AuthenticationError(
          customerMessage || i18n.t("errors.auth.unknownReason"),
        );
      }

      const accountInfo = dict.accountInfo as Record<string, any> | undefined;
      const address = accountInfo?.address as Record<string, any> | undefined;
      const passwordToken = String(dict.passwordToken ?? "");
      const directoryServicesIdentifier = String(dict.dsPersonId ?? "");

      if (!accountInfo || !passwordToken || !directoryServicesIdentifier) {
        throw new AuthenticationError(i18n.t("errors.auth.missingAccountInfo"));
      }

      const account: Account = {
        email,
        password,
        appleId: String(accountInfo.appleId ?? email),
        store: storeFront,
        firstName: String(address?.firstName ?? ""),
        lastName: String(address?.lastName ?? ""),
        passwordToken,
        directoryServicesIdentifier,
        cookies,
        deviceIdentifier: normalizedDeviceId,
        pod,
      };

      return account;
    }

    throw new AuthenticationError("Apple authentication exceeded the retry limit");
  } finally {
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
