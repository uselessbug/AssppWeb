import { Router, Request, Response } from "express";
import { validateDownloadURL } from "../services/downloadManager.js";
import { readRemoteIpaVersionMetadata } from "../services/remoteIpaMetadata.js";

const router = Router();

router.post("/version-metadata", async (req: Request, res: Response) => {
  const downloadURL = req.body?.downloadURL;

  if (typeof downloadURL !== "string" || !downloadURL.trim()) {
    res.status(400).json({ error: "Missing downloadURL" });
    return;
  }

  try {
    validateDownloadURL(downloadURL);
  } catch {
    res.status(400).json({ error: "Invalid download URL" });
    return;
  }

  try {
    const metadata = await readRemoteIpaVersionMetadata(downloadURL);
    res.json(metadata);
  } catch (error) {
    console.error("Failed to read version metadata from IPA", error);
    res.status(502).json({ error: "Failed to read version metadata from IPA" });
  }
});

export default router;
