/**
 * Claude API Integration for Outreach Generation
 * 
 * Generates personalized 3-email sequences using Claude Sonnet
 * with the "3 candidates in pipeline" angle
 */

interface ClaudeConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

interface OutreachEmails {
  email1_subject: string;
  email1_body: string;
  email2_subject: string;
  email2_body: string;
  email3_subject: string;
  email3_body: string;
}

interface MergedLead {
  firstName: string;
  lastName: string;
  title: string;
  companyName: string;
  companyDescription?: string;
  companyEmployeesCount?: string;
  companyIndustries?: string;
  industry?: string;
  personCity?: string;
  city?: string;
  personCountry?: string;
  country?: string;
  openRoles_titles?: string;
  openRoles_seniority?: string;
  openRoles_function?: string;
  openRoles_locations?: string;
  openRoles_descriptions?: string;
  openRoles_count?: string;
  jobPostUrls?: string[];
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

export function buildOutreachPrompt(lead: MergedLead): string {
  const firstName = lead.firstName || '';
  const lastName = lead.lastName || '';
  const title = lead.title || '';
  const company = lead.companyName || '';
  const companyDescription = truncate(lead.companyDescription, 800);
  const employees = lead.companyEmployeesCount || '';
  const industry = lead.companyIndustries || lead.industry || '';
  const city = lead.personCity || lead.city || '';
  const country = lead.personCountry || lead.country || '';
  const roleTitles = lead.openRoles_titles || '';
  const roleSeniority = lead.openRoles_seniority || '';
  const roleFunction = lead.openRoles_function || '';
  const roleLocations = lead.openRoles_locations || '';
  const roleDescriptions = truncate(lead.openRoles_descriptions, 2500);
  const roleCount = lead.openRoles_count || '';

  const jobPostUrlsList = (lead.jobPostUrls || []).slice(0, 3).join('\n');

  return `You are writing a 3-email cold outreach sequence for Jesse, who runs Upnest Talent, a curated marketplace of senior candidates (engineering, product, growth, sales, marketing).

The recipient is a contact at a company that has ACTIVE open roles right now. You have the FULL job descriptions below. Use them to craft hyper-specific candidate profiles that match EXACTLY what the role asks for.

WRITE IN ENGLISH. NO DASHES anywhere (not even em-dashes or en-dashes). Use commas or periods instead.
Tone: direct, casual, lowercase where it feels natural. No formal openers like "I hope this finds you well". No emojis.
Length: Email 1 max 55 words body (excluding candidate bullets). Email 2 max 25 words. Email 3 max 20 words.
CTA is SOFT: offer to send 2-3 anonymized profiles, no call requested.

STRICT STRUCTURE FOR EMAIL 1:
Line 1: "hi [firstName], saw you're hiring a [Exact Role Title]" or similar one-liner referencing ONE specific detail from the job description that proves you read it.
Line 2: "have 3 candidates in our pipeline right now who match:"
Then 3 bullet lines using commas to separate (NO dashes, NO bullet points, just new lines starting with a comma):
, [candidate 1: one specific matching detail from job requirements, e.g. industry + scale of impact]
, [candidate 2: different matching detail, e.g. relevant tech stack + years]
, [candidate 3: different matching detail, e.g. geography + domain expertise]
Last line: "want me to send over 2-3 anonymized profiles?"

CANDIDATE BULLET RULES:
- Each bullet must reference a SPECIFIC requirement from the FULL JOB DESCRIPTION below.
- Make them feel like REAL senior people: mention industry background, scale (users, revenue, team size), or specific tech/domain.
- NEVER use generic descriptions like "experienced professional" or "strong leader". Be concrete.
- Keep each bullet to 15-20 words max.

EMAIL 2: soft bump. "just checking if this landed, still have those 3 profiles ready for your [Role] role. want them?"
EMAIL 3: breakup. "2 of the 3 accepted offers elsewhere. 1 still available. yes/no?"

SUBJECT for Email 1: "3 candidates for your [Exact Role Title] role". Email 2: "Re: 3 candidates for your [Exact Role Title] role". Email 3: "closing the loop".

PERSONALIZATION:
- If openRoles_count > 1, pick the MOST senior or clearly defined role for the "3 candidates" angle.
- If recipient title suggests they are NOT the hiring manager, in Email 2 ask to redirect.

CONTEXT:
Name: ${firstName} ${lastName}
Their title: ${title}
Company: ${company}
Company description: ${companyDescription}
Employees: ${employees}
Industry: ${industry}
Person location: ${city}, ${country}

OPEN ROLES:
- Titles: ${roleTitles}
- Seniority: ${roleSeniority}
- Function: ${roleFunction}
- Locations: ${roleLocations}
- Number of open roles: ${roleCount}
- Job post links: ${jobPostUrlsList}

FULL JOB DESCRIPTIONS (use these to match candidate profiles precisely):
${roleDescriptions}

Sign as:
Jesse
Upnest Talent

(Email 2 and 3 just sign "Jesse")

OUTPUT (strict JSON, no preamble, no code fences):
{"email1_subject":"...","email1_body":"...","email2_subject":"...","email2_body":"...","email3_subject":"...","email3_body":"..."}`;
}

export async function callClaude(
  prompt: string,
  config: ClaudeConfig,
  retries = 5
): Promise<OutreachEmails | { error: string }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 429) {
        const wait = 8000 * (attempt + 1);
        console.warn(`429 rate limit, waiting ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (response.status === 529 || response.status === 503) {
        const wait = 5000 * (attempt + 1);
        console.warn(`${response.status} overloaded, waiting ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const data: any = await response.json();
      const text = data.content
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { text: string }) => c.text)
        .join('');
      const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(cleaned) as OutreachEmails;

      if (
        !parsed.email1_subject ||
        !parsed.email1_body ||
        !parsed.email2_subject ||
        !parsed.email2_body ||
        !parsed.email3_subject ||
        !parsed.email3_body
      ) {
        throw new Error('Missing required email fields in Claude response');
      }
      return parsed;
    } catch (e) {
      if (attempt === retries - 1) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return { error: 'Max retries exceeded' };
}

export default { buildOutreachPrompt, callClaude };
export type { ClaudeConfig, OutreachEmails, MergedLead };
