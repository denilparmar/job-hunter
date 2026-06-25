import { JWT } from "google-auth-library";
import { RankedJob } from "./common";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEET_NAME = "Jobs"; // tab name within the spreadsheet — must match exactly
// Column order written by appendJobs() below — keep in sync.
const HEADER_ROW = [
  "jobId",
  "score",
  "title",
  "company",
  "location",
  "salary",
  "source",
  "postedDate",
  "url",
  "reasoning",
  "dateAdded",
];

let cachedClient: JWT | null = null;

function getClient(clientEmail: string, privateKey: string): JWT {
  if (cachedClient) return cachedClient;
  cachedClient = new JWT({
    email: clientEmail,
    // SSM stores the key with literal "\n" sequences; convert back to real newlines.
    key: privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return cachedClient;
}

async function authedFetch(
  client: JWT,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const { token } = await client.getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Google Sheets API error: ${res.status} ${await res.text()}`
    );
  }
  return res;
}

/** Ensures the header row exists; called defensively on every run. */
async function ensureHeader(
  client: JWT,
  spreadsheetId: string
): Promise<void> {
  const range = `${SHEET_NAME}!A1:K1`;
  const res = await authedFetch(
    client,
    `${SHEETS_API}/${spreadsheetId}/values/${range}`
  );
  const data = (await res.json()) as { values?: string[][] };
  if (!data.values || data.values.length === 0) {
    await authedFetch(
      client,
      `${SHEETS_API}/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: [HEADER_ROW] }) }
    );
  }
}

/**
 * Reads column A (jobId) of the whole sheet and returns it as a Set,
 * used to skip jobs we've already written/alerted on before.
 */
export async function getSeenJobIds(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string
): Promise<Set<string>> {
  const client = getClient(clientEmail, privateKey);
  await ensureHeader(client, spreadsheetId);

  const res = await authedFetch(
    client,
    `${SHEETS_API}/${spreadsheetId}/values/${SHEET_NAME}!A2:A`
  );
  const data = (await res.json()) as { values?: string[][] };
  const ids = (data.values ?? []).map((row) => row[0]).filter(Boolean);
  return new Set(ids);
}

/** Appends new ranked jobs as rows at the bottom of the sheet. */
export async function appendJobs(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string,
  jobs: RankedJob[]
): Promise<void> {
  if (jobs.length === 0) return;
  const client = getClient(clientEmail, privateKey);

  const now = new Date().toISOString();
  const rows = jobs.map((j) => [
    j.jobId,
    j.score,
    j.title,
    j.company,
    j.location,
    j.salary ?? "",
    j.source,
    j.postedDate ?? "",
    j.url,
    j.reasoning,
    now,
  ]);

  await authedFetch(
    client,
    `${SHEETS_API}/${spreadsheetId}/values/${SHEET_NAME}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: rows }) }
  );
}