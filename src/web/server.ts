import { IngestionRepository } from "../storage/ingestion-repository";
import { OpenCodeSummarizer } from "../summarizer/opencode-summarizer";
import { PythonYoutubeTranscriptSource } from "../transcript/python-youtube-transcript-source";
import { handleRequest } from "./handler";
import { recoverInterruptedIngestions } from "./startup";

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";
const outputDir = process.env.VIDEO_DIGEST_OUTPUT_DIR ?? "outputs";
const dbPath = process.env.VIDEO_DIGEST_DB_PATH ?? "data/ingestions.sqlite";

const repository = new IngestionRepository({ dbPath });
const recoveredCount = recoverInterruptedIngestions(repository);
const summarizer = new OpenCodeSummarizer();
const transcriptSource = new PythonYoutubeTranscriptSource();

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    return handleRequest(request, {
      outputDir,
      repository,
      summarizer,
      transcriptSource,
    });
  },
});

const localUrl =
  hostname === "0.0.0.0" || hostname === "::"
    ? `http://127.0.0.1:${server.port}`
    : `http://${hostname}:${server.port}`;

console.log(`Video Digest web server running at ${localUrl}`);
if (recoveredCount > 0) {
  console.log(`Marked ${recoveredCount} interrupted ingestion(s) as failed`);
}
