import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import CompleteWorkflowManager from '../src/complete-workflow.js';

/**
 * Resume workflow from existing linkedin_jobs.csv (skip Step 1)
 * Usage: npx tsx examples/resume-from-jobs.ts
 */
async function main() {
  const csvPath = path.join(process.cwd(), 'output', 'linkedin_jobs.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('❌ output/linkedin_jobs.csv not found. Run full workflow first.');
    process.exit(1);
  }

  // Parse the CSV back into JobPost objects
  const csv = fs.readFileSync(csvPath, 'utf-8');
  const lines = csv.split('\n');
  const headers = lines[0].split(',');
  
  const jobs = lines.slice(1).filter(l => l.trim()).map(line => {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') { inQuotes = !inQuotes; continue; }
      if (char === ',' && !inQuotes) { values.push(current); current = ''; continue; }
      current += char;
    }
    values.push(current);

    const obj: any = {};
    headers.forEach((h, i) => obj[h.trim()] = (values[i] || '').trim());
    return {
      title: obj.title || '',
      company: obj.company || '',
      location: obj.location || '',
      companyWebsite: obj.companyWebsite || '',
      linkedInUrl: obj.linkedInUrl || '',
      posted_date: obj.posted_date || '',
      employment_type: obj.employment_type || '',
      industry: obj.industry || '',
      description: obj.description || '',
    };
  });

  console.log(`📂 Loaded ${jobs.length} jobs from CSV`);
  console.log('⏩ Skipping Step 1, resuming from Step 2...\n');

  const workflow = new CompleteWorkflowManager();

  // Step 2: Extract domains
  const domainMap = (workflow as any).extractCompanyDomains(jobs);

  // Step 3: Scrape decision makers
  const decisionMakers = await (workflow as any).scrapeDecisionMakers(Array.from(domainMap.keys()));

  // Step 4: Verify emails
  const verifiedLeads = await (workflow as any).verifyEmails(decisionMakers);
  if (verifiedLeads.length === 0) { console.log('❌ No verified emails.'); return; }

  // Step 5: Merge
  const mergedLeads = (workflow as any).mergeJobsAndLeads(verifiedLeads, domainMap);
  if (mergedLeads.length === 0) { console.log('❌ No merged leads.'); return; }

  // Step 6: Dedup
  const { leads: newLeads, decisionMakersMap } = (workflow as any).deduplicateLeads(mergedLeads, verifiedLeads, domainMap);
  if (newLeads.length === 0) { console.log('✅ All leads already processed.'); return; }

  // Step 7: Generate outreach (no limit)
  const emails = await (workflow as any).generateOutreachEmails(newLeads, 0);

  // Step 8: CSV + Instantly
  await (workflow as any).createInstantlyCSV(newLeads, emails, domainMap, decisionMakersMap);

  console.log('\n✨ Resumed workflow finished!');
  console.log(`📊 ${jobs.length} jobs → ${decisionMakers.length} DMs → ${verifiedLeads.length} verified → ${newLeads.length} new → ${emails.length} emails`);
}

main().catch(console.error);
