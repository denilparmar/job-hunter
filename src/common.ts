import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const cache = new Map<string, string>();

/**
 * Fetches an SSM parameter by suffix (relative to SSM_PREFIX), with
 * automatic decryption for SecureString params. Cached per warm Lambda
 * execution environment.
 */
export async function getParam(suffix: string): Promise<string> {
  const name = `${process.env.SSM_PREFIX}/${suffix}`;
  if (cache.has(name)) return cache.get(name)!;

  const res = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} has no value`);
  cache.set(name, value);
  return value;
}

/** Normalized job shape used across the whole pipeline. */
export interface NormalizedJob {
  jobId: string; // stable hash of company+title+location, used as the dedupe key in the sheet
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  source: string;
  postedDate?: string;
  salary?: string;
}

export interface RankedJob extends NormalizedJob {
  score: number; // 0-100, set by the OpenAI fit-scoring call
  reasoning: string; // one-line explanation from the model
}

/** Deterministic ID so the same posting dedupes across sources. */
export function buildJobId(job: {
  title: string;
  company: string;
  location: string;
}): string {
  const key = `${job.company}::${job.title}::${job.location}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 33) ^ key.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}