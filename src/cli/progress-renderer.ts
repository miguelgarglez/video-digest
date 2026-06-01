import type { IngestionProgressEvent } from "../ingestion/ingest-video";

export type ProgressRendererIO = {
  isTTY?: boolean;
  log: (message: string) => void;
  write?: (message: string) => void;
};

export type ProgressRenderer = {
  handle: (event: IngestionProgressEvent) => void;
  stop: () => void;
};

const spinnerFrames = ["-", "\\", "|", "/"];

export function createProgressRenderer(
  io: ProgressRendererIO,
  options: { intervalMs?: number } = {},
): ProgressRenderer {
  if (!io.isTTY || !io.write) {
    return createStaticProgressRenderer(io);
  }

  return createTerminalProgressRenderer(
    {
      log: io.log,
      write: io.write,
    },
    options.intervalMs ?? 120,
  );
}

function createStaticProgressRenderer(io: ProgressRendererIO): ProgressRenderer {
  return {
    handle(event) {
      io.log(staticProgressMessage(event));
    },
    stop() {},
  };
}

function createTerminalProgressRenderer(
  io: Required<Pick<ProgressRendererIO, "log" | "write">>,
  intervalMs: number,
): ProgressRenderer {
  let currentLabel: string | null = null;
  let frameIndex = 0;
  let timer: Timer | null = null;

  io.log("");
  io.log("+----------------------+");
  io.log("| VIDEO DIGEST         |");
  io.log("+----------------------+");

  function renderFrame(): void {
    if (!currentLabel) {
      return;
    }

    const frame = spinnerFrames[frameIndex % spinnerFrames.length];
    const dots = ".".repeat(frameIndex % 4);
    frameIndex += 1;
    io.write(`\r${frame} ${currentLabel}${dots}   `);
  }

  function start(label: string): void {
    finishActive();
    currentLabel = label;
    frameIndex = 0;
    renderFrame();

    if (intervalMs > 0) {
      timer = setInterval(renderFrame, intervalMs);
    }
  }

  function finishActive(): void {
    if (!currentLabel) {
      return;
    }

    stopTimer();
    io.write(`\r[ok] ${currentLabel}   \n`);
    currentLabel = null;
  }

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    handle(event) {
      if (event.stage === "completed") {
        finishActive();
        io.log("[done] Completed ingestion");
        return;
      }

      if (event.stage === "unusable-transcript") {
        finishActive();
        io.log("[skip] Transcript is unusable; skipping digest generation");
        return;
      }

      start(dynamicProgressLabel(event));
    },
    stop() {
      stopTimer();
      if (currentLabel) {
        io.write("\n");
        currentLabel = null;
      }
    },
  };
}

function staticProgressMessage(event: IngestionProgressEvent): string {
  const messages: Record<IngestionProgressEvent["stage"], string> = {
    completed: "[5/5] Completed ingestion",
    "fetching-transcript": `[1/5] Fetching transcript for ${event.videoId}`,
    "generating-digest": "[3/5] Generating digest",
    "scoring-transcript": "[2/5] Scoring transcript quality",
    "unusable-transcript": "Transcript is unusable; skipping digest generation",
    "writing-outputs": "[4/5] Writing output artifacts",
  };

  return messages[event.stage];
}

function dynamicProgressLabel(event: IngestionProgressEvent): string {
  switch (event.stage) {
    case "fetching-transcript":
      return `Fetching transcript for ${event.videoId}`;
    case "scoring-transcript":
      return "Scoring transcript quality";
    case "generating-digest":
      return "Generating digest";
    case "writing-outputs":
      return "Writing output artifacts";
    case "completed":
    case "unusable-transcript":
      return "";
  }
}
