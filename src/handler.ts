import {
  getParam,
  buildJobId,
  NormalizedJob,
  RankedJob,
} from "./common";
import { getSeenJobIds, appendJobs } from "./sheets";

const SCORE_THRESHOLD = 70; // 0-100 scale now — tune after seeing real scores
const MAX_ALERTS = 10;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

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
      description: description.slice(0, 3000), // keep prompt size sane
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
    }
  });
  return jobs;
}

// ---------------------------------------------------------------------
// Step 2: rank against your skills via an OpenAI chat call
// ---------------------------------------------------------------------

function buildSystemPrompt(skills: string): string {
  return [
    "You are a job-matching assistant.",
    `The user has the following skills and interests: ${skills}.`,
    "You will be given a JSON array of job postings, each with a jobId, title, company, location, and description.",
    "For each job, score how good a fit it is for someone with the user's skills, from 0 to 100 (100 = excellent match).",
    "Be honest and discriminating — most postings should NOT score above 80 unless the skills overlap is genuinely strong.",
    'Respond with ONLY valid JSON in this exact shape: {"results": [{"jobId": "...", "score": 0, "reasoning": "one short sentence"}]}',
    "Include exactly one result object per job you were given, in any order.",
  ].join(" ");
}

async function scoreJobsWithOpenAI(
  jobs: NormalizedJob[],
  skills: string,
  apiKey: string
): Promise<RankedJob[]> {
  if (jobs.length === 0) return [];

  const userPayload = jobs.map((j) => ({
    jobId: j.jobId,
    title: j.title,
    company: j.company,
    location: j.location,
    description: j.description,
  }));

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(skills) },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI chat completion failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content) as {
    results: { jobId: string; score: number; reasoning: string }[];
  };

  const scoreById = new Map(parsed.results.map((r) => [r.jobId, r]));

  return jobs
    .map((job) => {
      const result = scoreById.get(job.jobId);
      return {
        ...job,
        score: result?.score ?? 0,
        reasoning: result?.reasoning ?? "No score returned by model",
      };
    })
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
    return [
      `${i + 1}. *${escapeMd(j.title)}* — ${escapeMd(j.company)} (${j.score}/100)`,
      `   📍 ${escapeMd(j.location)}${j.salary ? ` · 💰 ${escapeMd(j.salary)}` : ""}`,
      `   _${escapeMd(j.reasoning)}_`,
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
  const skills = process.env.SKILLS;
  if (!skills) throw new Error("SKILLS environment variable is not set");

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

  // 3. Score via OpenAI against your skills list
  const ranked = await scoreJobsWithOpenAI(newJobs, skills, openaiKey);

  // 4. Write ALL new jobs (with scores) to the sheet for your own record
  await appendJobs(sheetClientEmail, sheetPrivateKey, spreadsheetId, ranked);

  // 5. Alert only on the strong matches
  const toAlert = ranked.filter((j) => j.score >= SCORE_THRESHOLD).slice(0, MAX_ALERTS);
  await sendTelegramAlert(toAlert);

  console.log(`Wrote ${ranked.length} rows, alerted on ${toAlert.length}`);
  return { fetched: jobs.length, new: newJobs.length, alerted: toAlert.length };
};