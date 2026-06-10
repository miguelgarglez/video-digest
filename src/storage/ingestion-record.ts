import type { IngestionProgressStage } from "../ingestion/ingest-video";

export type IngestionRecordStatus =
  | "completed"
  | "processing"
  | "unusable-transcript"
  | "transcript-unavailable"
  | "failed";

export type IngestionRecordProgressStage = "queued" | IngestionProgressStage;

export type IngestionRecord = {
  canonicalUrl: string;
  createdAt: string;
  digestPath: string | null;
  digestTitle: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  id: number;
  metadataPath: string | null;
  progressStage: IngestionRecordProgressStage | null;
  status: IngestionRecordStatus;
  transcriptPath: string | null;
  transcriptQualityStatus: string | null;
  updatedAt: string;
  videoId: string;
  warnings: string[];
};

export type SaveIngestionRecordInput = {
  canonicalUrl: string;
  digestPath?: string | null;
  digestTitle?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadataPath?: string | null;
  progressStage?: IngestionRecordProgressStage | null;
  status: IngestionRecordStatus;
  transcriptPath?: string | null;
  transcriptQualityStatus?: string | null;
  videoId: string;
  warnings?: string[];
};

export type SaveProcessingIngestionRecordInput = {
  canonicalUrl: string;
  progressStage: IngestionRecordProgressStage;
  videoId: string;
};
