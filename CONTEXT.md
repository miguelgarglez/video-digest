# Context

## Video ingestion

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Video** | A YouTube video selected by Miguel as potentially worth digesting. | Clip, item |
| **Source Playlist** | The YouTube playlist used as an inbox for videos to process. | Watch Later, queue |
| **Ingestion** | The act of accepting a video into the system for processing. | Import, capture |
| **Trigger** | The mechanism that starts ingestion or polling. | Automation, workflow |
| **Processed Video State** | A durable record that a video has already been processed or delivered. | History, cache |

## Transcript processing

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Transcript** | Timestamped text representing the spoken content of a video. | Captions, subtitles |
| **Transcript Source** | The provider or method used to obtain a transcript. | Extractor |
| **Transcript Quality** | A system estimate of whether a transcript is complete and useful enough to summarize. | Confidence |
| **Transcript Artifact** | A local technical file containing a full transcript for debugging and reproducibility. | Knowledge item |
| **Transcript Language Policy** | The rule that decides which transcript languages are preferred and whether translation is allowed. | Language fallback |
| **Transcript Provenance** | Metadata describing how a transcript was produced, such as whether it was manually authored or auto-generated. | Transcript quality |
| **Fallback** | A secondary method used when the preferred transcript source fails or is low quality. | Backup |

## Knowledge output

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Digest** | A structured summary of a video designed for fast consumption and later retrieval. | Summary |
| **Digest Title** | A generated title that describes the digest, not necessarily the original video title. | Video title |
| **Insight** | A useful idea extracted or inferred from one or more digests. | Takeaway |
| **Knowledge Item** | A durable note saved into the personal knowledge base. | Note, document |
| **Knowledge Base** | Miguel's personal system for storing and connecting knowledge items. | PKM, notes app |
| **Artifact Library** | A user-chosen durable collection of locally generated Digest and Transcript artifacts. | Output folder, output directory |
| **Library Entry** | The set of locally generated artifacts that belong to one Video in an Artifact Library. | File, result, artifact row |
| **Delivery** | Sending or placing a digest where Miguel will consume it, such as Gmail or a future knowledge base. | Notification, export |
| **Email Preview** | A Markdown artifact formatted as the body of a future email delivery. | Draft, email |

## Relationships

- A **Source Playlist** contains many **Videos**.
- **Processed Video State** prevents the same **Video** from being ingested or delivered repeatedly.
- A **Video** may have zero or more **Transcripts** from different **Transcript Sources**.
- A **Transcript Language Policy** guides which **Transcript** a **Transcript Source** should request first.
- **Transcript Provenance** describes origin metadata for a **Transcript** but does not determine **Transcript Quality** by itself.
- A **Transcript** has one **Transcript Quality** assessment.
- A **Transcript Artifact** stores a **Transcript** locally but is not a **Knowledge Item**.
- A **Digest** is generated from one **Video** and usually one **Transcript**.
- A **Digest Title** belongs to a **Digest** and may differ from the original **Video** title.
- **Delivery** sends or places a **Digest** for consumption.
- An **Email Preview** may be created from a **Digest** before Gmail **Delivery**.
- A **Knowledge Item** may be created from one or more **Digests**.
- An **Artifact Library** contains zero or more **Library Entries**.
- A **Library Entry** belongs to one **Video** and contains its available **Digest**, **Transcript Artifact**, and **Email Preview**.
- A **Trigger** starts either a single-video **Ingestion** or a playlist poll.
