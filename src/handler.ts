import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  getParam,
  buildJobId,
  cosineSimilarity,
  NormalizedJob,
  RankedJob,
} from "./common";
import { getSeenJobIds, appendJobs } from "./sheets";

const s3 = new S3Client({});
const BUCKET = process.env.DATA_BUCKET!;
const RESUME_EMBEDDING_KEY = "resume/embedding.json";

const SCORE_THRESHOLD = 0.78; // tune after seeing real scores come through
const MAX_ALERTS = 10;

// ---------------------------------------------------------------------
// Step 1: fetch + normalize from Apify
// ---------------------------------------------------------------------

// PLACEHOLDER actors — swap actorId + input for real ones from the Apify
// Store once you've picked your sources. Add a matching case in
// normalize() below for any actor you add, since each one returns
// differently-shaped fields.
const ACTORS: Array<{
  source: string;
  actorId: string;
  input: Record<string, unknown>;
}> = [
  {
    source: "indeed",
    actorId: "misceres~indeed-scraper",
    input: { position: "software engineer", country: "US", location: "Remote", maxItems: 50 },
  },
];

async function runApifyActor(
  actorId: string,
  input: Record<string, unknown>,
  token: string
): Promise<any[]> {
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Apify actor ${actorId} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as any[];
}

function normalize(source: string, raw: any): NormalizedJob | null {
  try {
    let title: string, company: string, location: string, description: string, url: string, postedDate: string | undefined, salary: string | undefined;

    switch (source) {
      case "indeed":
        title = raw.positionName ?? raw.title;
        company = raw.company;
        location = raw.location ?? "Remote";
        description = raw.description ?? "";
        url = raw.url ?? raw.jobUrl;
        postedDate = raw.postedAt;
        salary = raw.salary;
        break;
      case "glassdoor":
        title = raw.jobTitle ?? raw.title;
        company = raw.companyName ?? raw.company;
        location = raw.location ?? "Remote";
        description = raw.description ?? raw.jobDescription ?? "";
        url = raw.jobLink ?? raw.url;
        postedDate = raw.datePosted;
        salary = raw.salaryRange;
        break;
      default:
        // Generic fallback — add a real case above once you know the actor's field names.
        title = raw.title;
        company = raw.company;
        location = raw.location ?? "Remote";
        description = raw.description ?? "";
        url = raw.url;
        postedDate = raw.postedDate;
        salary = raw.salary;
    }

    if (!title || !company || !url) return null;

    return {
      jobId: buildJobId({ title, company, location }),
      title,
      company,
      location,
      description: description.slice(0, 6000),
      url,
      source,
      postedDate,
      salary,
    };
  } catch {
    return null;
  }
}

async function fetchAllJobs(apifyToken: string): Promise<NormalizedJob[]> {
  const results = await Promise.allSettled(
    ACTORS.map((a) => runApifyActor(a.actorId, a.input, apifyToken))
  );

  const jobs: NormalizedJob[] = [];
  results.forEach((result, idx) => {
    const source = ACTORS[idx].source;
    if (result.status === "fulfilled") {
      for (const raw of result.value) {
        const normalized = normalize(source, raw);
        if (normalized) jobs.push(normalized);
      }
    } else {
      console.error(`Source ${source} failed:`, result.reason);
      // One bad source shouldn't kill the whole run.
    }
  });
  return jobs;
}

// ---------------------------------------------------------------------
// Step 2: rank against resume embedding
// ---------------------------------------------------------------------

async function getResumeEmbedding(): Promise<number[]> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: RESUME_EMBEDDING_KEY })
  );
  const body = await res.Body!.transformToString();
  return (JSON.parse(body) as { embedding: number[] }).embedding;
}

async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

async function rankJobs(
  jobs: NormalizedJob[],
  openaiKey: string
): Promise<RankedJob[]> {
  if (jobs.length === 0) return [];
  const resumeEmbedding = await getResumeEmbedding();

  const BATCH = 50;
  const embeddings: number[][] = [];
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    const texts = batch.map((j) => `${j.title} at ${j.company}. ${j.description}`);
    embeddings.push(...(await embedTexts(texts, openaiKey)));
  }

  return jobs
    .map((job, i) => ({ ...job, score: cosineSimilarity(resumeEmbedding, embeddings[i]) }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------
// Step 3: Telegram alert
// ---------------------------------------------------------------------

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function formatMessage(jobs: RankedJob[]): string {
  const lines = jobs.map((j, i) => {
    const pct = Math.round(j.score * 100);
    return [
      `${i + 1}. *${escapeMd(j.title)}* — ${escapeMd(j.company)} (${pct}% match)`,
      `   📍 ${escapeMd(j.location)}${j.salary ? ` · 💰 ${escapeMd(j.salary)}` : ""}`,
      `   ${j.url}`,
    ].join("\n");
  });
  return [`*New job matches (${jobs.length})*`, "", ...lines].join("\n\n");
}

async function sendTelegramAlert(jobs: RankedJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const [botToken, chatId] = await Promise.all([
    getParam("telegram-bot-token"),
    getParam("telegram-chat-id"),
  ]);

  const CHUNK = 4;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i + CHUNK);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatMessage(chunk),
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

export const run = async (): Promise<{
  fetched: number;
  new: number;
  alerted: number;
}> => {
  const [apifyToken, openaiKey, sheetClientEmail, sheetPrivateKey, spreadsheetId] =
    await Promise.all([
      getParam("apify-token"),
      getParam("openai-api-key"),
      getParam("google-sheets-client-email"),
      getParam("google-sheets-private-key"),
      getParam("google-sheets-spreadsheet-id"),
    ]);

  // 1. Fetch
  const jobs = await fetchAllJobs(apifyToken);
  console.log(`Fetched ${jobs.length} normalized jobs`);

  // 2. Dedupe against what's already in the sheet
  const seenIds = await getSeenJobIds(sheetClientEmail, sheetPrivateKey, spreadsheetId);
  const newJobs = jobs.filter((j) => !seenIds.has(j.jobId));
  console.log(`${newJobs.length}/${jobs.length} jobs are new`);

  if (newJobs.length === 0) {
    return { fetched: jobs.length, new: 0, alerted: 0 };
  }

  // 3. Rank
  const ranked = await rankJobs(newJobs, openaiKey);

  // 4. Write ALL new jobs (with scores) to the sheet for your own record
  await appendJobs(sheetClientEmail, sheetPrivateKey, spreadsheetId, ranked);

  // 5. Alert only on the strong matches
  const toAlert = ranked.filter((j) => j.score >= SCORE_THRESHOLD).slice(0, MAX_ALERTS);
  await sendTelegramAlert(toAlert);

  console.log(`Wrote ${ranked.length} rows, alerted on ${toAlert.length}`);
  return { fetched: jobs.length, new: newJobs.length, alerted: toAlert.length };
};