import { expect, test } from "bun:test";
import { buildDoctorReport } from "./doctor";
import { runCli, type CliDependencies } from "./main";
import {
  PUBLIC_CLI_EXIT_CODES,
  PUBLIC_DOCTOR_CHECK_CAPABILITY,
  PUBLIC_DOCTOR_CHECK_IDS,
  PUBLIC_TUI_EXIT_CODES,
  type PublicCliExitCode,
  type PublicTuiExitCode,
} from "./public-contract";
import { startTui } from "../tui/start";

type CliExit = Awaited<ReturnType<typeof runCli>>;
type TuiExit = Awaited<ReturnType<typeof startTui>>;

const validCliExit: CliExit = 2;
const validTuiExit: TuiExit = 1;
const validPublicExit: PublicCliExitCode = 0;
const validPublicTuiExit: PublicTuiExitCode = 0;

// These type assertions make adding an undocumented process status a compile error.
// @ts-expect-error 3 is not a public CLI exit status.
const invalidCliExit: CliExit = 3;
// @ts-expect-error 3 is not a public TUI exit status.
const invalidTuiExit: TuiExit = 3;
// @ts-expect-error a dependency cannot inject an undocumented TUI process status.
const invalidDependencies = { startTui: async () => 3 } satisfies CliDependencies;
// @ts-expect-error exit 2 belongs to Transcript outcomes, not the TUI lifecycle.
const transcriptExitFromTui: TuiExit = 2;
// @ts-expect-error an injected TUI cannot return the Transcript-specific exit 2.
const transcriptExitFromDependency = { startTui: async () => 2 } satisfies CliDependencies;

void [
  validCliExit,
  validTuiExit,
  validPublicExit,
  validPublicTuiExit,
  invalidCliExit,
  invalidTuiExit,
  invalidDependencies,
  transcriptExitFromTui,
  transcriptExitFromDependency,
];

test("centralizes the complete Doctor ID and capability contract", async () => {
  expect(PUBLIC_DOCTOR_CHECK_IDS).toEqual([
    "bun",
    "uv",
    "python-sidecar",
    "python-runtime",
    "opencode-api-key",
    "output-dir",
  ]);
  expect(PUBLIC_DOCTOR_CHECK_CAPABILITY).toEqual({
    bun: "transcript",
    uv: "transcript",
    "python-sidecar": "transcript",
    "python-runtime": "transcript",
    "opencode-api-key": "digest",
    "output-dir": "transcript",
  });

  const report = await buildDoctorReport({
    bunVersion: "1.3.14",
    canWriteOutputDir: async () => true,
    env: {},
    fileExists: async () => true,
    getStoredOpenCodeApiKey: async () => null,
    runtimeReadiness: async () => ({ status: "ready" }),
    uvAvailable: async () => true,
  });
  expect(report.checks.map(({ id }) => id)).toEqual([...PUBLIC_DOCTOR_CHECK_IDS]);
  expect(Object.fromEntries(report.checks.map(({ capability, id }) => [id, capability])))
    .toEqual(PUBLIC_DOCTOR_CHECK_CAPABILITY);
});

test("publishes the exact CLI and TUI process statuses", () => {
  expect(PUBLIC_CLI_EXIT_CODES).toEqual([0, 1, 2]);
  expect(PUBLIC_TUI_EXIT_CODES).toEqual([0, 1]);
});
