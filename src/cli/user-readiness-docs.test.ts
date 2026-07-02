import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("user-readiness documentation", () => {
  test("states support before installation and keeps future work non-committal", async () => {
    const readme = await readFile("README.md", "utf8");
    const support = readme.indexOf("macOS on Apple Silicon");
    const install = readme.indexOf("## Install");

    expect(support).toBeGreaterThan(-1);
    expect(support).toBeLessThan(install);
    expect(readme).toContain("## Future possibilities");
    expect(readme).toContain("web interface");
    expect(readme).toContain("Windows and Linux");
    expect(readme).not.toContain("proxy");
    expect(readme).not.toContain("cloud-provider IPs");
  });

  test("keeps the web constraint internal and defines reevaluation conditions", async () => {
    const note = await readFile("docs/internal/web-interface-status.md", "utf8");

    expect(note).toContain("Status: Paused");
    expect(note).toContain("cloud-provider IPs");
    expect(note).toContain("recurring proxy cost");
    expect(note).toContain("## Reevaluation conditions");
  });

  test("asks for actionable bug reports without soliciting private data", async () => {
    const template = await readFile(".github/ISSUE_TEMPLATE/bug_report.md", "utf8");

    for (const heading of ["Steps to reproduce", "Expected behavior", "Actual behavior", "Technical context"]) {
      expect(template).toContain(`## ${heading}`);
    }
    expect(template).toContain("Do not include API keys");
    expect(template).toContain("Video Digest version");
    expect(template).toContain("macOS version");
    expect(template).toContain("Architecture");
  });
});
