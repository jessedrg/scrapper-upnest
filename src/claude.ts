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

  return `You write cold outreach emails for Jesse at Upnest Talent, a recruiting firm specializing in senior tech and business talent.

TASK: Write ONE short cold email to ${firstName} at ${company} about their open role(s). The email must feel like a real human recruiter wrote it in 30 seconds, not a template.

LANGUAGE: English only. NO dashes (em-dash, en-dash). Use commas or periods. All lowercase except proper nouns and start of sentences.

${seniorityInstructions}

JOB AGE: ${jobAgeContext}

GOLDEN EXAMPLE (study this format closely):
---
subject: senior software engineer, growth candidates

hi tony, saw you're hiring a Senior Software Engineer, Growth. personalized onboarding experiences through experiments sounds like a solid growth lever.

have 3 candidates in our pipeline right now who match:

• former datadog growth engineer, built onboarding experiments that improved activation 40%
• ex-stripe product engineer with strong UX eye, shipped user flows for 10M+ signups
• previous hubspot growth lead, ran A/B tests on cross-functional teams at 50k+ customer scale

want me to send over 2-3 anonymized profiles?

Jesse
Upnest Talent
---

RULES (follow these exactly):

1. HOOK: "hi [first name], saw you're hiring a [exact role title]. [one specific detail from the job description that shows you read it]."
   - The specific detail MUST come from the actual job description below. Pick something unique: a technology, a product area, a team challenge, a scale metric.
   - Keep it to ONE sentence after the role mention.

2. BRIDGE: "have [2-3] candidates in our pipeline right now who match:" (or similar natural variation)

3. CANDIDATE BULLETS (THIS IS THE MOST IMPORTANT PART):
   - Exactly 3 bullets, each starting with •
   - Each bullet must be HYPER REALISTIC and SPECIFIC to the job description
   - Format: "• [credibility marker: former/ex/previous] [well-known company] [relevant role], [specific achievement with numbers that directly relates to what the job needs]"
   - Read the job description carefully: what technologies do they need? what scale? what domain? what problems are they solving? Then craft candidates who have EXACTLY that experience.
   - Use real, well-known companies that make sense for the role (not random Fortune 500s, pick companies known for the relevant domain)
   - Include realistic metrics: percentages, user counts, ARR, team sizes, latency improvements, etc.
   - NEVER be vague. "experienced engineer" = BAD. "ex-cloudflare SRE, reduced p99 latency from 200ms to 12ms across 30+ microservices" = GOOD.

4. CTA: One casual line asking if they want to see profiles. Vary it naturally.

5. SIGN OFF: "Jesse\\nUpnest Talent"

SUBJECT LINE: lowercase, simple. Just "[exact role title] candidates" or "re: [exact role title]" or "[role] profiles for ${company}". No creativity needed.

FORMATTING: Use \\n for line breaks. Blank line between hook, bridge, bullets, CTA, and sign-off. The email must breathe.

CONTEXT:
Name: ${firstName} ${lastName}
Title: ${title}
Company: ${company}
Description: ${companyDescription}
Employees: ${employees}
Industry: ${industry}
Location: ${city}, ${country}

OPEN ROLES:
Titles: ${roleTitles}
Seniority: ${roleSeniority}
Function: ${roleFunction}
Locations: ${roleLocations}
Count: ${roleCount}

JOB DESCRIPTIONS (READ CAREFULLY to craft realistic matching candidates):
${roleDescriptions}

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
