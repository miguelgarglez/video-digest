import type { IngestionRepository } from "../storage/ingestion-repository";

const interruptedIngestionMessage =
  "The server restarted before this ingestion completed. Please submit the video again.";

export function recoverInterruptedIngestions(repository: IngestionRepository): number {
  return repository.failProcessingRecords({
    errorCode: "interrupted-ingestion",
    errorMessage: interruptedIngestionMessage,
  });
}
