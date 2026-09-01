import type { Account, Software } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { purchaseAPIHost } from "./config";
import i18n from "../i18n";

export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

export function isPurchaseAuthExpired(error: unknown): boolean {
  return (
    error instanceof PurchaseError &&
    (error.code === "2034" || error.code === "2042" || error.code === "1008")
  );
}

export async function purchaseApp(
  account: Account,
  app: Software,
): Promise<{ updatedCookies: typeof account.cookies }> {
  if ((app.price ?? 0) > 0) {
    throw new PurchaseError(i18n.t("errors.purchase.paidNotSupported"));
  }

  try {
    return await purchaseWithParams(account, app, "STDQ");
  } catch (e) {
    if (e instanceof PurchaseError && e.code === "2059") {
      return await purchaseWithParams(account, app, "GAME");
    }
    throw e;
  }
}

async function purchaseWithParams(
  account: Account,
  app: Software,
  pricingParameters: string,
): Promise<{ updatedCookies: typeof account.cookies }> {
  const deviceId = account.deviceIdentifier;
  const host = purchaseAPIHost(account.pod);
  const path = "/WebObjects/MZFinance.woa/wa/buyProduct";

  const payload: Record<string, any> = {
    appExtVrsId: "0",
    hasAskedToFulfillPreorder: "true",
    buyWithoutAuthorization: "true",
    hasDoneAgeCheck: "true",
    guid: deviceId,
    needDiv: "0",
    origPage: `Software-${app.id}`,
    origPageLocation: "Buy",
    price: "0",
    pricingParameters,
    productType: "C",
    salableAdamId: app.id,
  };

  const plistBody = buildPlist(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-apple-plist",
    "iCloud-DSID": account.directoryServicesIdentifier,
    "X-Dsid": account.directoryServicesIdentifier,
    "X-Apple-Store-Front": account.store,
    "X-Token": account.passwordToken,
  };

  const response = await appleRequest({
    method: "POST",
    host,
    path,
    headers,
    body: plistBody,
    cookies: account.cookies,
  });

  const updatedCookies = extractAndMergeCookies(
    response.rawHeaders,
    account.cookies,
    host,
  );

  const dict = parsePlist(response.body) as Record<string, any>;
  const failureType =
    dict.failureType === undefined || dict.failureType === null
      ? undefined
      : String(dict.failureType);
  const customerMessage = dict.customerMessage as string | undefined;
  const action = dict.action as Record<string, any> | undefined;
  const actionUrl = (action?.url || action?.URL) as string | undefined;

  if (actionUrl?.endsWith("termsPage")) {
    throw new PurchaseError(
      i18n.t("errors.purchase.termsRequired", { url: actionUrl }),
      failureType,
    );
  }

  if (customerMessage === "Your password has changed.") {
    throw new PurchaseError(i18n.t("errors.purchase.passwordExpired"), "2034");
  }

  if (customerMessage === "Subscription Required") {
    throw new PurchaseError(
      i18n.t("errors.purchase.subscriptionRequired"),
      failureType,
    );
  }

  if (failureType) {
    switch (failureType) {
      case "2059":
        throw new PurchaseError(i18n.t("errors.purchase.unavailable"), "2059");
      case "2034":
      case "2042":
      case "1008":
        throw new PurchaseError(
          i18n.t("errors.purchase.passwordExpired"),
          failureType,
        );
      case "5002":
        return { updatedCookies };
      default: {
        let msg = customerMessage;
        if (
          msg === "An unknown error has occurred" ||
          msg === "An unknown error has occurred."
        ) {
          msg = i18n.t("errors.purchase.unknownError");
        }
        throw new PurchaseError(
          msg ?? i18n.t("errors.purchase.failed", { failureType }),
          failureType,
        );
      }
    }
  }

  if (customerMessage) {
    const message =
      customerMessage === "An unknown error has occurred" ||
      customerMessage === "An unknown error has occurred."
        ? i18n.t("errors.purchase.unknownError")
        : customerMessage;
    throw new PurchaseError(message);
  }

  // ipatool treats a semantically bare HTTP 500 as already-owned only after
  // all explicit plist failure semantics above have been ruled out.
  if (response.status === 500) {
    return { updatedCookies };
  }

  const jingleDocType = dict.jingleDocType as string | undefined;
  const status = dict.status as number | undefined;

  if (jingleDocType !== "purchaseSuccess" || status !== 0) {
    throw new PurchaseError(i18n.t("errors.purchase.failedGeneral"));
  }

  return { updatedCookies };
}
