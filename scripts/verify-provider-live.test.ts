import { expect, test } from "bun:test";
import { parseLiveArgs, redactLiveReport } from "./verify-provider-live";

test("live verification requires explicit consent", () => {
  expect(parseLiveArgs(["--provider", "openai"])).toEqual({
    message: "Live verification requires --yes after reviewing its request scope.",
    ok: false,
  });
  expect(parseLiveArgs(["--provider", "openai", "--yes"])).toEqual({
    ok: true,
    provider: "openai",
    zenProtocol: null,
  });
});

test("live reports remove sensitive provider metadata", () => {
  expect(redactLiveReport({ model: "gpt", provider: "openai", requestId: "secret-id" }))
    .toEqual({ model: "gpt", provider: "openai" });
});

test("Zen protocol overrides are OpenCode-only", () => {
  expect(parseLiveArgs(["--provider", "openai", "--zen-protocol", "responses", "--yes"]).ok).toBe(false);
  expect(parseLiveArgs(["--provider", "opencode", "--zen-protocol", "anthropic-messages", "--yes"]))
    .toMatchObject({ ok: true, provider: "opencode", zenProtocol: "anthropic-messages" });
});
