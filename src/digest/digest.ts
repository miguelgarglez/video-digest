export type RelevantTimestamp = {
  note: string;
  timestamp: string;
};

export type DigestVerdict = "watch_full" | "watch_fragments" | "save_reference" | "discard";

export type DigestDraft = {
  actionableIdeas: string[];
  conceptsToInvestigate: string[];
  connections: string[];
  digestTitle: string;
  keyIdeas: string[];
  relevantTimestamps: RelevantTimestamp[];
  tldr: string[];
  verdict: DigestVerdict;
};

export type Digest = DigestDraft & {
  schemaVersion: "digest.v0";
};

export function createDigest(draft: DigestDraft): Digest {
  return {
    ...draft,
    schemaVersion: "digest.v0",
  };
}
