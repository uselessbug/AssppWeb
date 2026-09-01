import { Request, Response, NextFunction } from "express";
import { accessPasswordHash, config, verifyAccessToken } from "../config.js";

export function accessAuth(req: Request, res: Response, next: NextFunction) {
  if (!accessPasswordHash) {
    const normalizedPath = req.path.toLowerCase().replace(/\/+$/, "");
    if (
      normalizedPath === "/apple/authenticate" &&
      !config.unsafeAllowPublicAppleAuth
    ) {
      res.status(403).json({
        error:
          "Apple authentication requires ACCESS_PASSWORD unless UNSAFE_ALLOW_PUBLIC_APPLE_AUTH=true is explicitly configured",
        kind: "infrastructure",
        reason: "access_protection_required",
        eligibleForFreshRetry: false,
      });
      return;
    }
    next();
    return;
  }

  if (req.path.startsWith("/auth/") || req.path.startsWith("/install/")) {
    next();
    return;
  }

  const token = req.headers["x-access-token"];
  if (typeof token === "string" && verifyAccessToken(token)) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}
