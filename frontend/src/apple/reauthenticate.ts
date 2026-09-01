import { authenticate, AuthenticationError } from "./authenticate";
import { generateDeviceId, normalizeDeviceId } from "./config";
import type { Account } from "../types";

export class ReauthenticationCodeRequiredError extends AuthenticationError {
  constructor(
    message: string,
    public readonly freshSession: boolean,
  ) {
    super(message, true, "authentication");
    this.name = "ReauthenticationCodeRequiredError";
  }
}

export async function reauthenticateAccount(
  account: Account,
  code?: string,
  freshSession: boolean = false,
  onFreshRetry?: () => void,
): Promise<Account> {
  const normalizedDeviceId = normalizeDeviceId(account.deviceIdentifier || "");
  const deviceId = /^[a-f0-9]{12}$/.test(normalizedDeviceId)
    ? normalizedDeviceId
    : generateDeviceId();

  const run = (useFreshSession: boolean, verificationCode?: string) =>
    authenticate(
      account.email,
      account.password,
      verificationCode,
      useFreshSession ? [] : account.cookies,
      deviceId,
    );

  // Verification-code submissions always belong to a fresh authentication
  // attempt; cached cookies must never be restored for the code request.
  const initialFreshSession = freshSession || code !== undefined;

  try {
    return await run(initialFreshSession, code);
  } catch (error) {
    if (error instanceof AuthenticationError && error.codeRequired) {
      // Do not automatically invoke the helper again for a 2FA challenge.
      // The user's subsequent code submission will run fresh with cookies=[].
      throw new ReauthenticationCodeRequiredError(error.message, true);
    }

    if (
      !(error instanceof AuthenticationError) ||
      !error.eligibleForFreshRetry ||
      initialFreshSession
    ) {
      throw error;
    }

    onFreshRetry?.();
    try {
      return await run(true);
    } catch (freshError) {
      if (
        freshError instanceof AuthenticationError &&
        freshError.codeRequired
      ) {
        throw new ReauthenticationCodeRequiredError(
          freshError.message,
          true,
        );
      }
      throw freshError;
    }
  }
}
