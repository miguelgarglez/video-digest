import type { IngestionRecord, IngestionRecordProgressStage } from "../storage/ingestion-record";

export function statusLabel(status: IngestionRecord["status"]): string {
  const labels: Record<IngestionRecord["status"], string> = {
    completed: "Completado",
    failed: "Error",
    processing: "Procesando",
    "transcript-unavailable": "Sin transcripción",
    "unusable-transcript": "Transcripción no usable",
  };

  return labels[status];
}

export function progressLabel(progressStage: IngestionRecordProgressStage | null): string | null {
  if (!progressStage) {
    return null;
  }

  const labels: Record<IngestionRecordProgressStage, string> = {
    completed: "Completado",
    "fetching-transcript": "Obteniendo transcripción",
    "generating-digest": "Generando digest",
    queued: "En cola",
    "scoring-transcript": "Evaluando calidad de transcripción",
    "unusable-transcript": "Transcripción no usable",
    "writing-outputs": "Guardando resultado",
  };

  return labels[progressStage];
}
