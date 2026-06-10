import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  IngestionRecord,
  IngestionRecordProgressStage,
  SaveIngestionRecordInput,
  SaveProcessingIngestionRecordInput,
} from "./ingestion-record";

export type IngestionRepositoryOptions = {
  dbPath: string;
};

type IngestionRow = {
  canonical_url: string;
  created_at: string;
  digest_path: string | null;
  digest_title: string | null;
  error_code: string | null;
  error_message: string | null;
  id: number;
  metadata_path: string | null;
  progress_stage: string | null;
  status: string;
  transcript_path: string | null;
  transcript_quality_status: string | null;
  updated_at: string;
  video_id: string;
  warnings_json: string;
};

export class IngestionRepository {
  private readonly db: Database;

  constructor(options: IngestionRepositoryOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initializeSchema();
  }

  save(input: SaveIngestionRecordInput): IngestionRecord {
    const now = new Date().toISOString();
    const warningsJson = JSON.stringify(input.warnings ?? []);

    const statement = this.db.prepare(`
      INSERT INTO ingestions (
        video_id,
        canonical_url,
        status,
        transcript_quality_status,
        warnings_json,
        digest_title,
        transcript_path,
        digest_path,
        metadata_path,
        progress_stage,
        error_code,
        error_message,
        created_at,
        updated_at
      ) VALUES (
        $videoId,
        $canonicalUrl,
        $status,
        $transcriptQualityStatus,
        $warningsJson,
        $digestTitle,
        $transcriptPath,
        $digestPath,
        $metadataPath,
        $progressStage,
        $errorCode,
        $errorMessage,
        $createdAt,
        $updatedAt
      )
      ON CONFLICT(video_id) DO UPDATE SET
        canonical_url = excluded.canonical_url,
        status = excluded.status,
        transcript_quality_status = excluded.transcript_quality_status,
        warnings_json = excluded.warnings_json,
        digest_title = excluded.digest_title,
        transcript_path = excluded.transcript_path,
        digest_path = excluded.digest_path,
        metadata_path = excluded.metadata_path,
        progress_stage = excluded.progress_stage,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
      RETURNING *
    `);

    const row = statement.get({
      $videoId: input.videoId,
      $canonicalUrl: input.canonicalUrl,
      $status: input.status,
      $transcriptQualityStatus: input.transcriptQualityStatus ?? null,
      $warningsJson: warningsJson,
      $digestTitle: input.digestTitle ?? null,
      $transcriptPath: input.transcriptPath ?? null,
      $digestPath: input.digestPath ?? null,
      $metadataPath: input.metadataPath ?? null,
      $progressStage: input.progressStage ?? null,
      $errorCode: input.errorCode ?? null,
      $errorMessage: input.errorMessage ?? null,
      $createdAt: now,
      $updatedAt: now,
    }) as IngestionRow | null;

    if (!row) {
      throw new Error("Failed to save ingestion record");
    }

    return mapRow(row);
  }

  saveProcessing(input: SaveProcessingIngestionRecordInput): IngestionRecord {
    return this.save({
      canonicalUrl: input.canonicalUrl,
      progressStage: input.progressStage,
      status: "processing",
      videoId: input.videoId,
    });
  }

  updateProgressStage(
    videoId: string,
    progressStage: IngestionRecordProgressStage,
  ): IngestionRecord | null {
    const row = this.db
      .prepare(
        `
          UPDATE ingestions
          SET progress_stage = ?, updated_at = ?
          WHERE video_id = ? AND status = 'processing'
          RETURNING *
        `,
      )
      .get(progressStage, new Date().toISOString(), videoId) as IngestionRow | null;

    return row ? mapRow(row) : null;
  }

  failProcessingRecords(input: { errorCode: string; errorMessage: string }): number {
    const result = this.db
      .prepare(
        `
          UPDATE ingestions
          SET
            status = 'failed',
            progress_stage = NULL,
            error_code = $errorCode,
            error_message = $errorMessage,
            updated_at = $updatedAt
          WHERE status = 'processing'
        `,
      )
      .run({
        $errorCode: input.errorCode,
        $errorMessage: input.errorMessage,
        $updatedAt: new Date().toISOString(),
      });

    return result.changes;
  }

  findByVideoId(videoId: string): IngestionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM ingestions WHERE video_id = ?")
      .get(videoId) as IngestionRow | null;

    return row ? mapRow(row) : null;
  }

  listRecent(limit = 20): IngestionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM ingestions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as IngestionRow[];

    return rows.map(mapRow);
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ingestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL UNIQUE,
        canonical_url TEXT NOT NULL,
        status TEXT NOT NULL,
        transcript_quality_status TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        digest_title TEXT,
        transcript_path TEXT,
        digest_path TEXT,
        metadata_path TEXT,
        progress_stage TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ingestions_updated_at
        ON ingestions(updated_at DESC);
    `);

    this.addColumnIfMissing("ingestions", "progress_stage", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((existingColumn) => existingColumn.name === column)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function mapRow(row: IngestionRow): IngestionRecord {
  let warnings: string[] = [];

  try {
    const parsed = JSON.parse(row.warnings_json) as unknown;
    if (Array.isArray(parsed)) {
      warnings = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    warnings = [];
  }

  return {
    canonicalUrl: row.canonical_url,
    createdAt: row.created_at,
    digestPath: row.digest_path,
    digestTitle: row.digest_title,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    id: row.id,
    metadataPath: row.metadata_path,
    progressStage: row.progress_stage as IngestionRecord["progressStage"],
    status: row.status as IngestionRecord["status"],
    transcriptPath: row.transcript_path,
    transcriptQualityStatus: row.transcript_quality_status,
    updatedAt: row.updated_at,
    videoId: row.video_id,
    warnings,
  };
}
