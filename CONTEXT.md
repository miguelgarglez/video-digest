# Context

## Video ingestion

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Video** | A YouTube video selected by Miguel as potentially worth digesting. | Clip, item |
| **Source Playlist** | The YouTube playlist used as an inbox for videos to process. | Watch Later, queue |
| **Ingestion** | The act of accepting a video into the system for processing. | Import, capture |
| **Trigger** | The mechanism that starts ingestion or polling. | Automation, workflow |

## Transcript processing

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Transcript** | Timestamped text representing the spoken content of a video. | Captions, subtitles |
| **Transcript Source** | The provider or method used to obtain a transcript. | Extractor |
| **Transcript Quality** | A system estimate of whether a transcript is complete and useful enough to summarize. | Confidence |
| **Fallback** | A secondary method used when the preferred transcript source fails or is low quality. | Backup |

## Knowledge output

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Digest** | A structured summary of a video designed for fast consumption and later retrieval. | Summary |
| **Insight** | A useful idea extracted or inferred from one or more digests. | Takeaway |
| **Knowledge Item** | A durable note saved into the personal knowledge base. | Note, document |
| **Knowledge Base** | Miguel's personal system for storing and connecting knowledge items. | PKM, notes app |

## Relationships

- A **Source Playlist** contains many **Videos**.
- A **Video** may have zero or more **Transcripts** from different **Transcript Sources**.
- A **Transcript** has one **Transcript Quality** assessment.
- A **Digest** is generated from one **Video** and usually one **Transcript**.
- A **Knowledge Item** may be created from one or more **Digests**.
- A **Trigger** starts either a single-video **Ingestion** or a playlist poll.
