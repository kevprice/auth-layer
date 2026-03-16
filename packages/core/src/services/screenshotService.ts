import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { RenderViewport } from "@auth-layer/shared";

const execFile = promisify(execFileCallback);

export type ScreenshotCaptureResult = {
  body: Buffer;
  contentType: "image/png";
  screenshotFormat: "png";
  viewport: RenderViewport;
  devicePreset: string;
  userAgent: string;
  userAgentLabel: string;
};

export interface ScreenshotService {
  capture(url: string): Promise<ScreenshotCaptureResult | undefined>;
}

const DEFAULT_VIEWPORT: RenderViewport = { width: 1440, height: 960, pixelRatio: 1 };
const DEFAULT_DEVICE_PRESET = "desktop-default";

const candidateBrowserPaths = (): string[] => {
  const configured = process.env.RENDER_BROWSER_PATH?.trim();
  const candidates = [
    configured,
    process.platform === "win32" ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    "msedge",
    "google-chrome",
    "chromium",
    "chromium-browser"
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
};

const resolveExecutable = (): string | undefined => {
  for (const candidate of candidateBrowserPaths()) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    return candidate;
  }

  return undefined;
};

const buildUserAgentLabel = (browserPath: string): string => `${basename(browserPath).replace(/\.exe$/i, "")} headless`;

export class BrowserScreenshotService implements ScreenshotService {
  constructor(
    private readonly browserPath = resolveExecutable(),
    private readonly viewport: RenderViewport = DEFAULT_VIEWPORT,
    private readonly timeoutMs = 20_000,
    private readonly devicePreset = process.env.RENDER_DEVICE_PRESET?.trim() || DEFAULT_DEVICE_PRESET
  ) {}

  async capture(url: string): Promise<ScreenshotCaptureResult | undefined> {
    if (!this.browserPath) {
      return undefined;
    }

    const tempDirectory = await mkdtemp(join(tmpdir(), "auth-layer-screenshot-"));
    const outputPath = join(tempDirectory, "capture.png");

    try {
      const args = [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--disable-extensions",
        "--no-first-run",
        "--window-size=" + `${this.viewport.width},${this.viewport.height}`,
        "--virtual-time-budget=5000",
        `--screenshot=${outputPath}`,
        url
      ];

      if (process.platform !== "win32") {
        args.splice(4, 0, "--no-sandbox");
      }

      await execFile(this.browserPath, args, { timeout: this.timeoutMs });
      const body = await readFile(outputPath);
      const userAgentLabel = buildUserAgentLabel(this.browserPath);
      return {
        body,
        contentType: "image/png",
        screenshotFormat: "png",
        viewport: {
          width: this.viewport.width,
          height: this.viewport.height,
          pixelRatio: this.viewport.pixelRatio ?? 1
        },
        devicePreset: this.devicePreset,
        userAgent: userAgentLabel,
        userAgentLabel
      };
    } catch {
      return undefined;
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
