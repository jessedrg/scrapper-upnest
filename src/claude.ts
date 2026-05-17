/**
 * Claude API Integration for Outreach Generation
 * 
 * Generates personalized single outreach email using Claude Sonnet
 * with rotating angles, seniority-adaptive tone, and urgency signals
 */

interface ClaudeConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

interface OutreachEmails {
  email1_subject: string;
  email1_body: string;
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
  postedDate?: string;
  sourceRegion?: 'us' | 'europe' | 'apac' | 'remote';
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

/**
 * Detect seniority tier from recipient's job title
 */
function getSeniorityTier(title: string): 'executive' | 'director' | 'manager' | 'other' {
  const t = title.toLowerCase();
  if (/\b(ceo|cto|cfo|coo|cro|chief|founder|co-founder|partner|president|vp|vice president)\b/.test(t)) return 'executive';
  if (/\b(director|head of|svp|senior vice)\b/.test(t)) return 'director';
  if (/\b(manager|lead|team lead|supervisor)\b/.test(t)) return 'manager';
  return 'other';
}

/**
 * Calculate job age in days from posted date
 */
function getJobAgeDays(postedDate?: string): number | null {
  if (!postedDate) return null;
  const posted = new Date(postedDate);
  if (isNaN(posted.getTime())) return null;
  return Math.floor((Date.now() - posted.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Pick an angle based on lead index for deterministic rotation
 */
function pickAngle(lead: MergedLead, jobAgeDays: number | null): { id: string; label: string } {
  const angles = [
    { id: 'pipeline', label: 'candidates in pipeline' },
    { id: 'placement', label: 'recent similar placement' },
    { id: 'passive', label: 'passive candidate match' }
  ];
  // If job is old (14+ days), always use urgency angle
  if (jobAgeDays !== null && jobAgeDays >= 14) {
    return { id: 'stale', label: 'role open for a while' };
  }
  // Deterministic rotation based on name hash
  const hash = (lead.firstName + lead.companyName).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return angles[hash % angles.length];
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

  const seniority = getSeniorityTier(title);
  const jobAgeDays = getJobAgeDays(lead.postedDate);
  const angle = pickAngle(lead, jobAgeDays);

  const jobAgeContext = jobAgeDays !== null
    ? `This role has been open for approximately ${jobAgeDays} day(s). USE this as an urgency signal if >= 7 days (e.g. "noticed this has been open for a few weeks").`
    : 'Job age unknown. Do not reference how long it has been open.';

  let seniorityInstructions: string;
  switch (seniority) {
    case 'executive':
      seniorityInstructions = `The recipient is a C-level/VP executive. Be ULTRA concise. Max 35 words body (excluding bullets). No fluff. 2 candidate bullets max (8-10 words each). Respect their time.`;
      break;
    case 'director':
      seniorityInstructions = `The recipient is a Director/Head of. Be concise but can include slightly more context. Max 45 words body. 2 candidate bullets (10-12 words each).`;
      break;
    default:
      seniorityInstructions = `The recipient is a hiring manager or recruiter. Can include more technical detail. Max 50 words body. 2 candidate bullets (10-15 words each).`;
      break;
  }

  let angleInstructions: string;
  switch (angle.id) {
    case 'pipeline':
      angleInstructions = `ANGLE: "candidates in pipeline". Mention you have pre-vetted profiles that match their requirements. Frame as: "we have profiles in our network that match".`;
      break;
    case 'placement':
      angleInstructions = `ANGLE: "recent placement". Reference that you recently placed someone in a similar role in the same industry/function. Frame as: "we just placed a [similar role] at a [similar type] company, have 2 more candidates from that search".`;
      break;
    case 'passive':
      angleInstructions = `ANGLE: "passive candidate". Mention you have a passive candidate (not actively looking) who matches their specific requirements. Frame as: "have a passive candidate who fits, they're not on the market yet".`;
      break;
    case 'stale':
      angleInstructions = `ANGLE: "urgency/stale role". The role has been open for a while. Reference this tactfully: "noticed this has been open for a bit, we might be able to help speed things up". Show you can deliver quickly.`;
      break;
    default:
      angleInstructions = `ANGLE: "candidates in pipeline". Mention you have pre-vetted profiles that match.`;
  }

  return `You are writing a single cold outreach email for Jesse, who runs Upnest Talent, a curated marketplace of senior candidates (engineering, product, growth, sales, marketing).

The recipient is a contact at a company that has ACTIVE open roles right now.

WRITE IN ENGLISH. NO DASHES anywhere (not even em-dashes or en-dashes). Use commas or periods instead.
Tone: direct, casual, lowercase where it feels natural. No formal openers. No emojis.

${seniorityInstructions}

${angleInstructions}

JOB AGE: ${jobAgeContext}

HOOK RULES (CRITICAL):
- Your opening line MUST reference something SPECIFIC from the company description, NOT just the role title.
- Good: "hi [name], saw [company] just raised a series B / is expanding into [market] / launched [product]. noticed you're hiring a [role]."
- Bad: "hi [name], saw you're hiring a [role]." (too generic, NEVER do this)
- If company description is empty, reference the specific tech stack or unique requirement from the job description instead.

CANDIDATE BULLET RULES:
- Only 2 bullets, NOT 3.
- Each bullet: 8-12 words max. Ultra specific.
- Reference domain expertise, scale numbers (ARR, users, team size), or well-known company types.
- Frame as TYPES of candidates, not fictional individuals. Say "ex-[type of company], scaled [thing] to [number]" not "John who did X".
- NEVER say "experienced professional", "strong leader", "proven track record". Be concrete.

SUBJECT LINE RULES:
- NEVER use the same formula every time. Pick ONE of these based on what fits best:
  1. "[exact role title] candidates for ${company}"
  2. "re: your [exact role title] search"
  3. "quick question about your [exact role title] hire"
  4. "${company} + Upnest Talent"
- Subject must be lowercase, short, feel like a real person wrote it.

CTA RULES:
- Vary the CTA. Pick ONE:
  1. "want me to send over a couple anonymized profiles?"
  2. "worth a look? can send profiles over today."
  3. "one of them is in final stages elsewhere, let me know if you want to see profiles before they're gone."
  4. "happy to send a quick shortlist, just say the word."
- Match urgency to job age: if role is 14+ days old, use a more urgent CTA.

STRICT STRUCTURE (follow this EXACT spacing with blank lines between sections):

[hook: greeting + company-specific observation + role mention]
\n
[angle-specific bridge line introducing candidates]
\n
, [candidate bullet 1]
, [candidate bullet 2]
\n
[CTA]
\n
Jesse
Upnest Talent

IMPORTANT FORMATTING: Use \n between each section. The email must breathe. Never write it as one dense paragraph.

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

OUTPUT (strict JSON, no preamble, no code fences):
{"email1_subject":"...","email1_body":"..."}`;
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
        !parsed.email1_body
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
