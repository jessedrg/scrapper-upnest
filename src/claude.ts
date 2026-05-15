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
Length: Email 1 max 80 words body. Email 2 shorter. Email 3 shortest.
CTA is SOFT: offer to send 2-3 anonymized profiles, no call requested.

ANGLE FOR EMAIL 1: We have 3 specific candidates in our pipeline who match this role. For each candidate, invent a SHORT but SPECIFIC detail pulled DIRECTLY from the job description requirements below. For example:
- If the role asks for "5+ years in ML infrastructure" → "one built ML pipelines at a Series B fintech processing 2M events/day"
- If the role asks for "experience with React and Node" → "one led a full-stack rewrite from Angular to React/Node for a 50-person startup"
- If the role needs "healthcare domain" → "one spent 4 years at a digital health company scaling from 10 to 200 patients/day"

The candidates must feel REAL and PRECISELY matching the job requirements. The reader should feel that if they say yes, profiles arrive in their inbox today.

PERSONALIZATION RULES:
- Reference the SPECIFIC role title they are hiring for by name.
- Pull ONE specific detail from the job description or company description that proves you actually read it (tech stack, mission, growth stage, specific responsibility). Weave it naturally into the email.
- If recipient title suggests they are NOT the hiring manager (AE, sales rep, engineer), in Email 2 ask them to redirect to the hiring manager.
- If openRoles_count > 1, mention "noticed you're scaling the ${roleFunction} team" but keep the "3 candidates" framing focused on the most senior role.
- Email 2 is a soft bump: reference the 3 candidates again, shorter, ask if it landed or went to spam.
- Email 3 is breakup: 2 of the 3 candidates accepted offers elsewhere, 1 still available, ask yes/no.

SUBJECT for Email 1: "3 candidates for your [Exact Role Title] role". Email 2: "Re: 3 candidates for your [Exact Role Title] role". Email 3: "closing the loop".

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
