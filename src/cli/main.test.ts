import { describe, expect, test } from "bun:test";
import { runCli } from "./main";

describe("runCli", () => {
  test("prints parsed video information", () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = runCli(["https://youtu.be/1ZgUcrR0K7I", "--email-preview"], {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual([
      "Video ID: 1ZgUcrR0K7I",
      "Canonical URL: https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      "Email preview: yes",
    ]);
  });

  test("prints usage errors and exits non-zero", () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = runCli([], {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["Usage: bun run video-digest <youtube-url> [--email-preview]"]);
  });
});
