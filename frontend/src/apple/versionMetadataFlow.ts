import { reauthenticateAccount } from "./reauthenticate";
import {
  getVersionMetadata,
  isVersionLookupAuthExpired,
} from "./versionLookup";
import type { Account, Software } from "../types";

export async function getVersionMetadataWithReauth(
  account: Account,
  app: Software,
  versionId: string,
  persistReauthenticatedAccount: (account: Account) => Promise<void>,
) {
  let currentAccount = account;
  let result: Awaited<ReturnType<typeof getVersionMetadata>>;

  try {
    result = await getVersionMetadata(currentAccount, app, versionId);
  } catch (error) {
    if (!isVersionLookupAuthExpired(error)) throw error;
    currentAccount = await reauthenticateAccount(currentAccount);
    await persistReauthenticatedAccount(currentAccount);
    result = await getVersionMetadata(currentAccount, app, versionId);
  }

  return { ...result, account: currentAccount };
}
