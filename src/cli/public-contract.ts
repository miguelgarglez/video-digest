/** Public machine-contract values shared by serializers, domain errors, and docs. */
export const PUBLIC_CLI_SCHEMA = {
  cliResult: "cli-result.v0",
  configResult: "config-result.v0",
  configStatus: "config-status.v0",
  doctorReport: "doctor-report.v0",
  libraryList: "library-list.v0",
  openResult: "open-result.v0",
  setupResult: "setup-result.v0",
} as const;

export const PUBLIC_CLI_SCHEMA_VERSIONS = Object.freeze(Object.values(PUBLIC_CLI_SCHEMA));

export const PUBLIC_CLI_ERROR_CODE = {
  alreadyRunning: "already-running",
  conflictingOptions: "conflicting-options",
  consentRequired: "consent-required",
  copyFailed: "copy-failed",
  duplicateOption: "duplicate-option",
  interactiveRequired: "interactive-required",
  invalidProviderResponse: "invalid-provider-response",
  invalidUrl: "invalid-url",
  libraryEntryNotFound: "library-entry-not-found",
  libraryEntryNotOpenable: "library-entry-not-openable",
  missingApiKey: "missing-api-key",
  missingOptionValue: "missing-option-value",
  missingUrl: "missing-url",
  openFailed: "open-failed",
  providerFailed: "provider-failed",
  recoveryRequired: "recovery-required",
  revealFailed: "reveal-failed",
  runtimeNotReady: "runtime-not-ready",
  setupFailed: "setup-failed",
  transcriptUnavailable: "transcript-unavailable",
  unexpectedError: "unexpected-error",
  unsupportedCommand: "unsupported-command",
  unsupportedOption: "unsupported-option",
} as const;

export const PUBLIC_CLI_ERROR_CODES = Object.freeze(Object.values(PUBLIC_CLI_ERROR_CODE));
export type PublicCliErrorCode = typeof PUBLIC_CLI_ERROR_CODES[number];

export const PUBLIC_CLI_EXIT_CODES = [0, 1, 2] as const;
export type PublicCliExitCode = typeof PUBLIC_CLI_EXIT_CODES[number];

export const PUBLIC_DOCTOR_CHECK_ID = {
  bun: "bun",
  opencodeApiKey: "opencode-api-key",
  outputDir: "output-dir",
  pythonRuntime: "python-runtime",
  pythonSidecar: "python-sidecar",
  uv: "uv",
} as const;

export const PUBLIC_DOCTOR_CHECK_IDS = [
  PUBLIC_DOCTOR_CHECK_ID.bun,
  PUBLIC_DOCTOR_CHECK_ID.uv,
  PUBLIC_DOCTOR_CHECK_ID.pythonSidecar,
  PUBLIC_DOCTOR_CHECK_ID.pythonRuntime,
  PUBLIC_DOCTOR_CHECK_ID.opencodeApiKey,
  PUBLIC_DOCTOR_CHECK_ID.outputDir,
] as const;

export type PublicDoctorCheckId = typeof PUBLIC_DOCTOR_CHECK_IDS[number];
export type PublicDoctorCapability = "digest" | "transcript";

export const PUBLIC_DOCTOR_CHECK_CAPABILITY = {
  [PUBLIC_DOCTOR_CHECK_ID.bun]: "transcript",
  [PUBLIC_DOCTOR_CHECK_ID.uv]: "transcript",
  [PUBLIC_DOCTOR_CHECK_ID.pythonSidecar]: "transcript",
  [PUBLIC_DOCTOR_CHECK_ID.pythonRuntime]: "transcript",
  [PUBLIC_DOCTOR_CHECK_ID.opencodeApiKey]: "digest",
  [PUBLIC_DOCTOR_CHECK_ID.outputDir]: "transcript",
} as const satisfies Record<PublicDoctorCheckId, PublicDoctorCapability>;
