import { describe, expect, test } from "bun:test";
import {
  FEEDBACK_EMAIL,
  buildFeedbackLinks,
  resolveSupportContext,
  type SupportContext,
} from "./feedback";

const context: SupportContext = {
  appVersion: "1.0.0 beta",
  architecture: "arm64/test",
  macOSVersion: "26.5.1",
};

describe("buildFeedbackLinks", () => {
  test("encodes reviewable email and GitHub drafts from allowlisted context", () => {
    const links = buildFeedbackLinks(context, "failed-workflow");
    const email = new URL(links.email);
    const issue = new URL(links.githubIssue);

    expect(email.protocol).toBe("mailto:");
    expect(email.pathname).toBe(FEEDBACK_EMAIL);
    expect(email.searchParams.get("subject")).toBe("Video Digest feedback");
    expect(email.searchParams.get("body")).toContain("Video Digest: 1.0.0 beta");
    expect(email.searchParams.get("body")).toContain("Opened from: Failed workflow");
    expect(issue.origin).toBe("https://github.com");
    expect(issue.pathname).toBe("/miguelgarglez/video-digest/issues/new");
    expect(issue.searchParams.get("title")).toBe("[Bug] ");
    expect(issue.searchParams.get("body")).toContain("Architecture: arm64/test");
  });

  test("percent-encodes mailto spaces instead of exposing form-style plus signs", () => {
    const { email } = buildFeedbackLinks(context, "main-menu");

    expect(email).toContain("subject=Video%20Digest%20feedback");
    expect(email).toContain("body=What%20were%20you%20trying%20to%20do%3F");
    expect(email).not.toContain("+");
  });

  test("does not introduce non-allowlisted application data", () => {
    const serialized = JSON.stringify(buildFeedbackLinks(context, "main-menu"));

    expect(serialized).not.toContain("/Users/miguel");
    expect(serialized).not.toContain("youtube.com");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("Transcript content");
  });
});

describe("resolveSupportContext", () => {
  test("reads the macOS product version through the injected native runner", async () => {
    const commands: string[][] = [];
    const result = await resolveSupportContext({
      appVersion: "1.0.0",
      architecture: "arm64",
      run: async (command) => {
        commands.push([...command]);
        return { exitCode: 0, stderr: "", stdout: "26.5.1\n" };
      },
    });

    expect(commands).toEqual([["/usr/bin/sw_vers", "-productVersion"]]);
    expect(result).toEqual({ appVersion: "1.0.0", architecture: "arm64", macOSVersion: "26.5.1" });
  });

  test("falls back to unknown for failed or malformed product-version lookups", async () => {
    const runners = [
      async () => ({ exitCode: 1, stderr: "private failure", stdout: "" }),
      async () => { throw new Error("private failure"); },
      async () => ({ exitCode: 0, stderr: "", stdout: "26.5.1\nextra" }),
    ];

    for (const run of runners) {
      await expect(resolveSupportContext({ appVersion: "1.0.0", architecture: "arm64", run }))
        .resolves.toEqual({ appVersion: "1.0.0", architecture: "arm64", macOSVersion: "unknown" });
    }
  });
});
