/**
 * Complete Workflow with Claude Integration
 * 
 * 1. Scrape LinkedIn jobs via Apify actor (curious_coder~linkedin-jobs-scraper)
 * 2. Scrape decision makers from those companies
 * 3. Verify emails via Million Verifier (account56~email-verifier)
 * 4. Merge jobs and leads data (only verified emails)
 * 5. Deduplicate (skip already-processed job+lead combos)
 * 6. Generate outreach emails with Claude Sonnet
 * 7. Export final CSV for Instantly
 */

import axios from 'axios';
import { LeadsScraperTaskRunner } from './leads-scraper-task-runner.js';
import { buildOutreachPrompt, callClaude, type MergedLead, type OutreachEmails } from './claude.js';
import { US_URLS, EUROPE_URLS, ASIA_URLS, ALL_URLS } from '../config/urls.js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

interface JobPost {
  title: string;
  company: string;
  location: string;
  companyWebsite?: string;
  linkedInUrl?: string;
  posted_date?: string;
  employment_type?: string;
  industry?: string;
  description?: string;
}

interface DecisionMaker {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  companyName: string;
  linkedIn?: string;
  seniority?: string;
  function?: string;
  location?: string;
}

interface InstantlyRecord {
  lastName: string;
  firstName: string;
  companyName: string;
  jobTitle: string;
  linkedIn: string;
  email1_body: string;
  email2_body: string;
  email3_body: string;
  jobPostUrls: string;
  pause_until: string;
  email1_subject: string;
  email2_subject: string;
  email3_subject: string;
}


class CompleteWorkflowManager {
  private leadsRunner: LeadsScraperTaskRunner;
  private claudeConfig: any;
  private apifyToken: string;
  private readonly JOBS_ACTOR = 'curious_coder~linkedin-jobs-scraper';
  private readonly EMAIL_VERIFIER_ACTOR = 'michael.g~email-verifier-validator';
  private readonly MAILS_API_KEY = process.env.MAILS_API_KEY || '';
  private readonly MAILS_API_URL = 'https://api.mails.so/v1';
  private readonly DEDUP_FILE = path.join(process.cwd(), 'output', 'processed_keys.txt');
  private readonly INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY || '';
  private readonly INSTANTLY_CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID || '';

  constructor() {
    this.apifyToken = process.env.APIFY_TOKEN || '';
    if (!this.apifyToken) {
      throw new Error('APIFY_TOKEN environment variable is required');
    }

    this.leadsRunner = new LeadsScraperTaskRunner();
    
    this.claudeConfig = {
      apiKey: process.env.CLAUDE_API_KEY || '',
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1024
    };

    if (!this.claudeConfig.apiKey) {
      throw new Error('CLAUDE_API_KEY environment variable is required');
    }
  }

  // ─── POLLING HELPER (with retry on transient errors) ───────────────────────

  private async pollRunStatus(runId: string, label: string, maxWaitMs: number = 1800000): Promise<void> {
    const pollInterval = 10000;
    let elapsed = 0;

    while (elapsed < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollInterval));
      elapsed += pollInterval;

      try {
        const resp = await axios.get(
          `https://api.apify.com/v2/actor-runs/${runId}`,
          { params: { token: this.apifyToken }, timeout: 15000 }
        );

        const status = resp.data?.data?.status;
        if (status === 'SUCCEEDED') {
          console.log(`   ✅ ${label} finished in ${Math.round(elapsed / 1000)}s`);
          return;
        } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          throw new Error(`${label} run ${status}`);
        }

        process.stdout.write(`   ⏳ ${label}... (${Math.round(elapsed / 1000)}s, status: ${status})\r`);
      } catch (err: any) {
        const httpStatus = err?.response?.status;
        if (httpStatus === 502 || httpStatus === 503 || httpStatus === 429) {
          console.log(`   ⚠️  Transient error (${httpStatus}), retrying...`);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`${label} timed out (${Math.round(maxWaitMs / 60000)}min)`);
  }

  // ─── DEDUPLICATION (line-based for 100K+ scale) ─────────────────────────────

  private loadProcessedKeys(): Set<string> {
    const outputDir = path.dirname(this.DEDUP_FILE);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    if (!fs.existsSync(this.DEDUP_FILE)) {
      return new Set();
    }
    const content = fs.readFileSync(this.DEDUP_FILE, 'utf-8');
    const keys = new Set<string>();
    for (const line of content.split('\n')) {
      if (line.trim()) keys.add(line.trim());
    }
    return keys;
  }

  private appendProcessedKeys(newKeys: string[]): void {
    const outputDir = path.dirname(this.DEDUP_FILE);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    // Append only new keys (fast, no rewrite)
    fs.appendFileSync(this.DEDUP_FILE, newKeys.join('\n') + '\n');
  }

  private buildKey(jobPostUrl: string, email: string): string {
    return `${jobPostUrl}__${email}`;
  }

  /**
   * Extract domain from company website or name
   */
  private extractDomain(company: string, website?: string): string {
    if (website) {
      return website.replace(/^https?:\/\//, '').split('/')[0];
    }
    if (company) {
      return company.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '') + '.com';
    }
    return '';
  }

  /**
   * Save data to CSV
   */
  private async saveToCSV(data: any[], filename: string): Promise<void> {
    const csvPath = path.join(process.cwd(), 'output', filename);
    
    const outputDir = path.dirname(csvPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    if (data.length === 0) {
      console.log(`⚠️ No data to save for ${filename}`);
      return;
    }

    const headers = Object.keys(data[0]);
    const csvContent = [
      headers.join(','),
      ...data.map(row => 
        headers.map(header => {
          const value = row[header];
          if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value || '';
        }).join(',')
      )
    ].join('\n');

    fs.writeFileSync(csvPath, csvContent);
    console.log(`✅ Saved ${data.length} records to ${csvPath}`);
  }

  /**
   * Check if there's a successful Jobs Scraper run from today we can reuse
   */
  private async getReusableJobsRun(): Promise<{ datasetId: string; itemCount: number } | null> {
    try {
      const resp = await axios.get(
        `https://api.apify.com/v2/acts/${this.JOBS_ACTOR}/runs`,
        {
          params: { token: this.apifyToken, limit: 5, desc: true, status: 'SUCCEEDED' },
          timeout: 15000
        }
      );

      const runs = resp.data?.data?.items || [];
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      for (const run of runs) {
        const runDate = (run.finishedAt || run.startedAt || '').slice(0, 10);
        if (runDate === today && run.defaultDatasetId) {
          // Verify it has items
          const dsResp = await axios.get(
            `https://api.apify.com/v2/datasets/${run.defaultDatasetId}`,
            { params: { token: this.apifyToken }, timeout: 15000 }
          );
          const itemCount = dsResp.data?.data?.itemCount || 0;
          if (itemCount > 0) {
            return { datasetId: run.defaultDatasetId, itemCount };
          }
        }
      }
    } catch (err: any) {
      console.log(`   ⚠️  Could not check for reusable runs: ${err.message}`);
    }
    return null;
  }

  /**
   * Step 1: Scrape LinkedIn jobs using async actor run (no timeout)
   * Reuses today's run if available to avoid duplicate Apify costs
   */
  async scrapeJobs(urls: string[] = ALL_URLS, count: number = 10000): Promise<JobPost[]> {
    console.log('📊 Step 1: Scraping LinkedIn jobs...');
    console.log(`🌍 Using ${urls.length} URLs, requesting ${count} jobs`);

    let datasetId: string;

    // Check for a reusable run from today
    const reusable = await this.getReusableJobsRun();
    if (reusable) {
      console.log(`   ♻️  Found today's run with ${reusable.itemCount} jobs — reusing dataset`);
      datasetId = reusable.datasetId;
    } else {
      // Start a new actor run
      const startResponse = await axios.post(
        `https://api.apify.com/v2/acts/${this.JOBS_ACTOR}/runs`,
        {
          urls,
          scrapeCompany: true,
          count: Math.max(count, 10)
        },
        {
          params: { token: this.apifyToken },
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );

      const runId = startResponse.data?.data?.id;
      datasetId = startResponse.data?.data?.defaultDatasetId;
      if (!runId) throw new Error('Failed to start Apify actor run');
      console.log(`   🏃 Actor run started: ${runId}`);

      // Poll until finished (with retry on transient errors)
      await this.pollRunStatus(runId, 'Jobs Scraper');
    }

    // Fetch dataset items
    console.log(`   📥 Fetching results from dataset...`);
    const itemsResponse = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items`,
      {
        params: { token: this.apifyToken, format: 'json' },
        timeout: 60000
      }
    );

    const jobs = Array.isArray(itemsResponse.data) ? itemsResponse.data : [];

    const processedJobs: JobPost[] = jobs.map((job: any) => ({
      title: job.title || '',
      company: job.companyName || job.company || '',
      location: job.location || '',
      companyWebsite: job.companyWebsite || job.companyUrl || '',
      linkedInUrl: job.link || job.jobUrl || job.linkedInUrl || '',
      posted_date: job.postedAt || job.posted_date || '',
      employment_type: job.employmentType || job.contractType || '',
      industry: Array.isArray(job.industries) ? job.industries.join(', ') : (job.industries || job.industry || ''),
      description: job.descriptionText || job.description || ''
    }));

    await this.saveToCSV(processedJobs, 'linkedin_jobs.csv');
    console.log(`✅ Scraped ${processedJobs.length} real job postings`);
    return processedJobs;
  }

  /**
   * Step 2: Extract company domains
   */
  extractCompanyDomains(jobs: JobPost[]): Map<string, JobPost[]> {
    console.log('🏢 Step 2: Extracting company domains...');
    
    const domainMap = new Map<string, JobPost[]>();
    
    jobs.forEach(job => {
      const domain = this.extractDomain(job.company, job.companyWebsite);
      
      if (!domainMap.has(domain)) {
        domainMap.set(domain, []);
      }
      
      domainMap.get(domain)!.push(job);
    });

    console.log(`✅ Extracted ${domainMap.size} unique company domains`);
    return domainMap;
  }

  /**
   * Check if there's a successful Leads Scraper run from today we can reuse
   */
  private readonly LEADS_ACTOR = 'jupri~leads-scraper';

  private async getReusableLeadsRun(): Promise<{ datasetId: string; itemCount: number } | null> {
    try {
      const resp = await axios.get(
        `https://api.apify.com/v2/actor-tasks/verifiable_cougar~scrape-desicion-makers/runs`,
        {
          params: { token: this.apifyToken, limit: 5, desc: true, status: 'SUCCEEDED' },
          timeout: 15000
        }
      );

      const runs = resp.data?.data?.items || [];
      const today = new Date().toISOString().slice(0, 10);

      for (const run of runs) {
        const runDate = (run.finishedAt || run.startedAt || '').slice(0, 10);
        if (runDate === today && run.defaultDatasetId) {
          const dsResp = await axios.get(
            `https://api.apify.com/v2/datasets/${run.defaultDatasetId}`,
            { params: { token: this.apifyToken }, timeout: 15000 }
          );
          const itemCount = dsResp.data?.data?.itemCount || 0;
          if (itemCount > 0) {
            return { datasetId: run.defaultDatasetId, itemCount };
          }
        }
      }
    } catch (err: any) {
      console.log(`   ⚠️  Could not check for reusable leads runs: ${err.message}`);
    }
    return null;
  }

  /**
   * Step 3: Scrape decision makers
   * Reuses today's run if available
   */
  async scrapeDecisionMakers(domains: string[]): Promise<DecisionMaker[]> {
    console.log('🎯 Step 3: Scraping decision makers...');

    let datasetId: string;

    const reusable = await this.getReusableLeadsRun();
    if (reusable) {
      console.log(`   ♻️  Found today's leads run with ${reusable.itemCount} DMs — reusing dataset`);
      datasetId = reusable.datasetId;
    } else {
      await this.leadsRunner.updateCompanyDomains(domains);
      
      await this.leadsRunner.setupDecisionMakers({
        titles: [
          'Head of Talent', 'Head of Talent Acquisition', 'Head of Recruiting',
          'VP Talent', 'VP Talent Acquisition', 'VP People',
          'Director of Recruiting', 'Director of Talent', 'Director of Talent Acquisition',
          'Head of People', 'Head of HR',
          'CTO', 'VP Engineering', 'VP of Engineering', 'Head of Engineering',
          'Director of Engineering', 'Engineering Manager',
          'Co-Founder', 'Founder', 'CEO'
        ],
        seniority: ['c_suite', 'vp', 'director', 'manager'],
        functions: ['human_resources', 'engineering', 'operations'],
        countries: ['United States', 'United Kingdom', 'Germany', 'France', 'Canada', 'Australia'],
        leadCount: 15000,
        requireEmail: true
      });

      const runInfo = await this.leadsRunner.runAsync();
      const runId = runInfo.id;
      datasetId = runInfo.defaultDatasetId;
      console.log(`   🏃 Leads Scraper run started: ${runId}`);

      await this.pollRunStatus(runId, 'Leads Scraper');
    }

    // Fetch dataset items
    console.log(`   📥 Fetching leads from dataset...`);
    const itemsResp = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items`,
      { params: { token: this.apifyToken, format: 'json' }, timeout: 120000 }
    );
    const leads = Array.isArray(itemsResp.data) ? itemsResp.data : [];
    
    const processedLeads: DecisionMaker[] = leads.map(lead => ({
      name: lead.name || '',
      firstName: lead.firstName || lead.name?.split(' ')[0] || '',
      lastName: lead.lastName || lead.name?.split(' ').slice(1).join(' ') || '',
      email: lead.email || '',
      jobTitle: lead.title || '',
      companyName: lead.company || lead.companyName || '',
      linkedIn: lead.linkedIn || '',
      seniority: lead.seniority,
      function: lead.function,
      location: lead.location
    }));

    await this.saveToCSV(processedLeads, 'decision_makers.csv');
    console.log(`✅ Found ${processedLeads.length} decision makers`);
    return processedLeads;
  }

  /**
   * Step 4: Verify emails using mails.so (primary) with Apify fallback
   */
  async verifyEmails(decisionMakers: DecisionMaker[]): Promise<DecisionMaker[]> {
    const emails = decisionMakers.map(dm => dm.email).filter(Boolean);
    
    if (emails.length === 0) {
      console.log('⚠️ No emails to verify');
      return [];
    }

    console.log(`📧 Step 4: Verifying ${emails.length} emails...`);

    // Try mails.so only; if it fails, skip verification and continue
    let results: any[] | null = null;

    if (this.MAILS_API_KEY) {
      results = await this.verifyWithMailsSo(emails);
    }

    if (!results) {
      console.log(`   ➡️  Verification unavailable. Continuing with ${decisionMakers.length} emails (unverified)`);
      return decisionMakers.filter(dm => dm.email);
    }

    // Classify results
    const validEmails = new Set<string>();
    const riskyEmails = new Set<string>();
    const invalidEmails = new Set<string>();

    results.forEach((result: any) => {
      const email = (result.email || '').toLowerCase();
      if (!email) return;

      // mails.so format
      if (result.result) {
        const r = result.result.toLowerCase();
        if (r === 'deliverable') {
          validEmails.add(email);
        } else if (r === 'unknown' || r === 'risky') {
          riskyEmails.add(email);
        } else {
          invalidEmails.add(email);
        }
        return;
      }

      // Apify format
      const status = (result.status || '').toLowerCase();
      const catchAll = result.catch_all === true;
      const syntaxValid = result.verification_details?.checks?.syntax_valid ?? true;
      const mxValid = result.verification_details?.checks?.mx_records_valid ?? true;
      const disposable = result.disposable === true;

      if (status === 'good') {
        validEmails.add(email);
      } else if (catchAll) {
        riskyEmails.add(email);
      } else if (!syntaxValid || !mxValid || disposable) {
        invalidEmails.add(email);
      } else {
        riskyEmails.add(email);
      }
    });

    console.log(`   ✅ Deliverable: ${validEmails.size}`);
    console.log(`   ⚠️  Risky/Unknown: ${riskyEmails.size}`);
    console.log(`   ❌ Invalid: ${invalidEmails.size}`);

    // Keep valid + risky, discard only truly invalid
    const verified = decisionMakers.filter(dm => {
      const emailLower = dm.email.toLowerCase();
      return validEmails.has(emailLower) || riskyEmails.has(emailLower);
    });

    console.log(`✅ ${verified.length}/${decisionMakers.length} decision makers passed verification`);
    await this.saveToCSV(verified, 'verified_decision_makers.csv');
    return verified;
  }

  /**
   * Verify emails via mails.so batch API (async polling)
   */
  private async verifyWithMailsSo(emails: string[]): Promise<any[] | null> {
    console.log(`   📨 Using mails.so batch verification...`);

    try {
      // Step 1: Submit batch
      const batchResponse = await axios.post(
        `${this.MAILS_API_URL}/batch`,
        { emails },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-mails-api-key': this.MAILS_API_KEY
          },
          timeout: 30000
        }
      );

      const batchId = batchResponse.data?.id;
      if (!batchId) {
        console.log('   ⚠️  mails.so: No batch ID returned');
        return null;
      }

      console.log(`   📦 Batch submitted: ${batchId} (${emails.length} emails)`);

      // Step 2: Poll for results
      const maxWait = 120000; // 2 min max
      const pollInterval = 3000; // 3 sec
      let elapsed = 0;

      while (elapsed < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));
        elapsed += pollInterval;

        const statusResponse = await axios.get(
          `${this.MAILS_API_URL}/batch/${batchId}`,
          {
            headers: { 'x-mails-api-key': this.MAILS_API_KEY },
            timeout: 15000
          }
        );

        const data = statusResponse.data;
        if (data.finished_at) {
          console.log(`   ✅ mails.so batch completed in ${elapsed / 1000}s`);
          return data.emails || [];
        }

        process.stdout.write(`   ⏳ Polling... (${elapsed / 1000}s)\r`);
      }

      console.log('   ⚠️  mails.so: Timeout waiting for batch results');
      return null;

    } catch (err: any) {
      const errMsg = err?.response?.data?.error || err.message || 'Unknown error';
      console.log(`   ⚠️  mails.so failed: ${errMsg}`);
      return null;
    }
  }

  /**
   * Verify emails via Apify actor (fallback) — in batches with async polling
   */
  private async verifyWithApify(emails: string[]): Promise<any[] | null> {
    console.log(`   📨 Using Apify email verifier (fallback)...`);

    const BATCH_SIZE = 500;
    const allResults: any[] = [];

    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(emails.length / BATCH_SIZE);
      console.log(`   📨 Verifying batch ${batchNum}/${totalBatches} (${batch.length} emails)...`);

      try {
        // Start async run
        const startResp = await axios.post(
          `https://api.apify.com/v2/acts/${this.EMAIL_VERIFIER_ACTOR}/runs`,
          { emails: batch },
          {
            params: { token: this.apifyToken },
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
          }
        );

        const runId = startResp.data?.data?.id;
        const datasetId = startResp.data?.data?.defaultDatasetId;
        if (!runId) {
          console.log(`   ⚠️  Batch ${batchNum}: No run ID returned, skipping`);
          continue;
        }

        // Poll until finished
        await this.pollRunStatus(runId, `Email Verifier batch ${batchNum}`, 600000);

        // Fetch results
        const itemsResp = await axios.get(
          `https://api.apify.com/v2/datasets/${datasetId}/items`,
          { params: { token: this.apifyToken, format: 'json' }, timeout: 60000 }
        );
        const items = Array.isArray(itemsResp.data) ? itemsResp.data : [];
        allResults.push(...items);
        console.log(`   ✅ Batch ${batchNum}: ${items.length} results`);

      } catch (err: any) {
        console.log(`   ⚠️  Batch ${batchNum} failed: ${err.message}`);
      }
    }

    return allResults.length > 0 ? allResults : null;
  }

  /**
   * Step 5: Merge jobs and leads data properly
   */
  mergeJobsAndLeads(
    decisionMakers: DecisionMaker[], 
    domainMap: Map<string, JobPost[]>
  ): MergedLead[] {
    console.log('🔗 Step 5: Merging jobs and leads data...');

    const mergedLeads: MergedLead[] = [];
    let matches = 0;

    console.log(`🔍 Checking ${decisionMakers.length} decision makers against ${domainMap.size} company domains`);

    decisionMakers.forEach(decisionMaker => {
      const domain = this.extractDomain(decisionMaker.companyName);
      const companyJobs = domainMap.get(domain);
      
      if (!companyJobs || companyJobs.length === 0) {
        // Try fuzzy matching
        const fuzzyMatch = this.findFuzzyMatch(decisionMaker.companyName, domainMap);
        if (fuzzyMatch) {
          matches++;
          const mergedLead = this.createMergedLead(decisionMaker, fuzzyMatch.jobs);
          mergedLeads.push(mergedLead);
        }
        return;
      }

      matches++;
      const mergedLead = this.createMergedLead(decisionMaker, companyJobs);
      mergedLeads.push(mergedLead);
    });

    console.log(`✅ Found ${matches} matches, merged ${mergedLeads.length} leads with job data`);
    return mergedLeads;
  }

  /**
   * Find fuzzy match for company name
   */
  private findFuzzyMatch(companyName: string, domainMap: Map<string, JobPost[]>): { company: string, jobs: JobPost[] } | null {
    const companyLower = companyName.toLowerCase();
    
    for (const [domain, jobs] of domainMap.entries()) {
      const jobCompany = jobs[0]?.company?.toLowerCase() || '';
      const jobWebsite = jobs[0]?.companyWebsite?.toLowerCase() || '';
      
      // Check if company name contains job company or vice versa
      if (companyLower.includes(jobCompany) || jobCompany.includes(companyLower)) {
        return { company: jobs[0].company, jobs };
      }
      
      // Check domain matching
      if (domain.includes(companyLower.replace(/\s+/g, '')) || 
          companyLower.replace(/\s+/g, '').includes(domain)) {
        return { company: jobs[0].company, jobs };
      }
    }
    
    return null;
  }

  /**
   * Create merged lead from decision maker and jobs
   */
  private createMergedLead(decisionMaker: DecisionMaker, companyJobs: JobPost[]): MergedLead {
    return {
      firstName: decisionMaker.firstName,
      lastName: decisionMaker.lastName,
      title: decisionMaker.jobTitle,
      companyName: decisionMaker.companyName,
      openRoles_titles: companyJobs.map(job => job.title).join(' | '),
      openRoles_seniority: 'senior',
      openRoles_function: this.extractFunctionFromTitles(companyJobs.map(job => job.title)),
      openRoles_locations: companyJobs.map(job => job.location).join(' | '),
      openRoles_count: companyJobs.length.toString(),
      openRoles_descriptions: companyJobs.slice(0, 3).map(job => (job.description || '').slice(0, 500)).filter(Boolean).join('\n\n'),
      personCity: decisionMaker.location?.split(',').map(s => s.trim())[0],
      personCountry: decisionMaker.location?.split(',').map(s => s.trim()).pop(),
      industry: companyJobs[0]?.industry || '',
      jobPostUrls: companyJobs.map(job => job.linkedInUrl).filter(Boolean) as string[]
    };
  }

  /**
   * Extract function from job titles
   */
  private extractFunctionFromTitles(titles: string[]): string {
    const titleText = titles.join(' ').toLowerCase();
    
    if (titleText.includes('engineer') || titleText.includes('developer')) return 'engineering';
    if (titleText.includes('sales') || titleText.includes('revenue')) return 'sales';
    if (titleText.includes('market') || titleText.includes('growth')) return 'marketing';
    if (titleText.includes('product')) return 'product';
    if (titleText.includes('design')) return 'design';
    if (titleText.includes('data')) return 'data';
    
    return 'general';
  }

  /**
   * Step 6: Filter out already-processed leads
   */
  deduplicateLeads(
    mergedLeads: MergedLead[],
    decisionMakers: DecisionMaker[],
    domainMap: Map<string, JobPost[]>
  ): { leads: MergedLead[], decisionMakersMap: Map<string, DecisionMaker> } {
    console.log('🔄 Step 6: Deduplicating leads...');

    const processedKeys = this.loadProcessedKeys();
    const newLeads: MergedLead[] = [];
    const dmMap = new Map<string, DecisionMaker>();

    // Build DM lookup by email (supports multiple DMs per company)
    decisionMakers.forEach(dm => {
      if (dm.email) {
        dmMap.set(dm.email.toLowerCase(), dm);
      }
    });

    mergedLeads.forEach(lead => {
      // Find the DM that matches this merged lead (by name)
      const dm = decisionMakers.find(d => 
        d.firstName === lead.firstName && d.lastName === lead.lastName && 
        d.companyName.toLowerCase() === lead.companyName.toLowerCase()
      );
      if (!dm || !dm.email) return;

      // Check if ANY of the job post URLs for this lead+email are new
      const jobUrls = lead.jobPostUrls || [];
      const hasNewJob = jobUrls.length === 0 
        ? !processedKeys.has(this.buildKey(lead.companyName, dm.email))
        : jobUrls.some(url => !processedKeys.has(this.buildKey(url, dm.email)));

      if (hasNewJob) {
        newLeads.push(lead);
      }
    });

    const skipped = mergedLeads.length - newLeads.length;
    if (skipped > 0) {
      console.log(`   ⏭️  Skipped ${skipped} already-processed leads`);
    }
    console.log(`✅ ${newLeads.length} new leads to process`);

    return { leads: newLeads, decisionMakersMap: dmMap };
  }

  /**
   * Step 7+8: Generate outreach emails + write CSV + dedup incrementally
   * Each email is written to CSV and marked as processed immediately.
   * If the process crashes mid-way, completed records are preserved.
   * Pushes to Instantly in batches of 50.
   */
  async generateAndExport(
    mergedLeads: MergedLead[],
    domainMap: Map<string, JobPost[]>,
    decisionMakersMap: Map<string, DecisionMaker>,
    limit: number = 0
  ): Promise<number> {
    console.log('🤖 Step 7+8: Generating emails & writing CSV incrementally...');

    const limitedLeads = limit > 0 ? mergedLeads.slice(0, limit) : mergedLeads;
    const csvPath = path.join(process.cwd(), 'output', 'instantly_campaign.csv');
    const outputDir = path.dirname(csvPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Write CSV header
    const headers = ['lastName','firstName','companyName','jobTitle','linkedIn','email1_body','email2_body','email3_body','jobPostUrls','pause_until','email1_subject','email2_subject','email3_subject'];
    fs.writeFileSync(csvPath, headers.join(',') + '\n');

    let generated = 0;
    const instantlyBatch: InstantlyRecord[] = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < limitedLeads.length; i++) {
      const lead = limitedLeads[i];
      console.log(`📧 ${i + 1}/${limitedLeads.length}: ${lead.firstName} ${lead.lastName} @ ${lead.companyName}`);

      const prompt = buildOutreachPrompt(lead);
      const result = await callClaude(prompt, this.claudeConfig);

      if ('error' in result) {
        console.error(`   ❌ Claude error: ${result.error}`);
        continue;
      }

      const domain = this.extractDomain(lead.companyName);
      const companyJobs = domainMap.get(domain) || [];
      const dm = Array.from(decisionMakersMap.values()).find(d =>
        d.firstName === lead.firstName && d.lastName === lead.lastName &&
        d.companyName.toLowerCase() === lead.companyName.toLowerCase()
      );

      // Use jobPostUrls from MergedLead (set in Step 5), fallback to domainMap
      const jobUrls = (lead.jobPostUrls && lead.jobPostUrls.length > 0)
        ? lead.jobPostUrls
        : companyJobs.map(job => job.linkedInUrl).filter(Boolean) as string[];

      const pauseUntil = new Date();
      pauseUntil.setDate(pauseUntil.getDate() + 3);

      const record: InstantlyRecord = {
        lastName: lead.lastName,
        firstName: lead.firstName,
        companyName: lead.companyName,
        jobTitle: lead.title,
        linkedIn: dm?.linkedIn || '',
        email1_body: result.email1_body,
        email2_body: result.email2_body,
        email3_body: result.email3_body,
        jobPostUrls: jobUrls.join(' ||| '),
        pause_until: pauseUntil.toISOString(),
        email1_subject: result.email1_subject,
        email2_subject: result.email2_subject,
        email3_subject: result.email3_subject
      };

      // Append row to CSV immediately
      const row = headers.map(h => {
        const val = String((record as any)[h] || '').replace(/"/g, '""');
        return `"${val}"`;
      }).join(',');
      fs.appendFileSync(csvPath, row + '\n');

      // Mark dedup immediately — one key per job post URL
      const dedupUrls = jobUrls.length > 0 ? jobUrls : [lead.companyName];
      const dedupKeys = dedupUrls.map(url => this.buildKey(url, dm?.email || ''));
      this.appendProcessedKeys(dedupKeys);

      instantlyBatch.push(record);
      generated++;

      // Push to Instantly in batches
      if (instantlyBatch.length >= BATCH_SIZE) {
        if (this.INSTANTLY_API_KEY && this.INSTANTLY_CAMPAIGN_ID) {
          await this.pushToInstantly([...instantlyBatch], decisionMakersMap);
        }
        instantlyBatch.length = 0;
      }

      // Rate limit delay
      await new Promise(r => setTimeout(r, 1000));
    }

    // Push remaining batch
    if (instantlyBatch.length > 0 && this.INSTANTLY_API_KEY && this.INSTANTLY_CAMPAIGN_ID) {
      await this.pushToInstantly(instantlyBatch, decisionMakersMap);
    }

    const totalKeys = this.loadProcessedKeys().size;
    console.log(`💾 Dedup registry: +${generated} new (${totalKeys} total)`);
    console.log(`✅ Generated & exported ${generated} campaign records to ${csvPath}`);
    return generated;
  }

  /**
   * Step 9: Push leads to Instantly campaign via API
   */
  private async pushToInstantly(
    records: InstantlyRecord[],
    decisionMakersMap: Map<string, DecisionMaker>
  ): Promise<void> {
    console.log(`🚀 Step 9: Pushing ${records.length} leads to Instantly campaign...`);

    const leads = records.map(record => {
      // Find DM by name + company match
      const dm = Array.from(decisionMakersMap.values()).find(d =>
        d.firstName === record.firstName && d.lastName === record.lastName &&
        d.companyName.toLowerCase() === record.companyName.toLowerCase()
      );
      return {
        email: dm?.email || '',
        first_name: record.firstName,
        last_name: record.lastName,
        company_name: record.companyName,
        custom_variables: {
          jobTitle: record.jobTitle,
          linkedIn: record.linkedIn,
          email1_body: record.email1_body,
          email2_body: record.email2_body,
          email3_body: record.email3_body,
          jobPostUrls: record.jobPostUrls,
          pause_until: record.pause_until,
          email1_subject: record.email1_subject,
          email2_subject: record.email2_subject,
          email3_subject: record.email3_subject
        }
      };
    }).filter(lead => lead.email);

    if (leads.length === 0) {
      console.log('   ⚠️  No leads with emails to push');
      return;
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(
          'https://api.instantly.ai/api/v2/leads/add',
          {
            campaign_id: this.INSTANTLY_CAMPAIGN_ID,
            leads: leads.map(lead => ({
              email: lead.email,
              first_name: lead.first_name,
              last_name: lead.last_name,
              company_name: lead.company_name,
              custom_variables: lead.custom_variables
            }))
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.INSTANTLY_API_KEY}`
            },
            timeout: 30000
          }
        );

        const data = response.data;
        console.log(`✅ Instantly: ${data.leads_uploaded || leads.length} uploaded, ${data.duplicated_leads || 0} duplicates, ${data.invalid_email_count || 0} invalid`);
        return; // Success, exit
      } catch (err: any) {
        const httpStatus = err?.response?.status;
        const errData = err?.response?.data;
        console.error(`   ❌ Instantly push failed (attempt ${attempt}/${maxRetries}):`, errData || err.message);

        if (attempt < maxRetries && (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || !httpStatus)) {
          const delay = attempt * 5000;
          console.log(`   ⏳ Retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    console.error(`   ⚠️  Instantly push failed after ${maxRetries} attempts. Leads are saved in CSV — push manually or re-run.`);
  }

  /**
   * Execute complete workflow
   */
  async executeCompleteWorkflow(urls?: string[], limit: number = 3): Promise<void> {
    try {
      console.log('🚀 Starting Complete Workflow: Jobs → Leads → Verify → Dedup → Claude → Instantly\n');
      console.log(`🔢 Outreach: ${limit > 0 ? limit + ' records' : 'NO LIMIT'}\n`);

      // Step 1: Scrape jobs
      const jobs = await this.scrapeJobs(urls);

      // Step 2: Extract domains
      const domainMap = this.extractCompanyDomains(jobs);

      // Step 3: Scrape decision makers
      const decisionMakers = await this.scrapeDecisionMakers(Array.from(domainMap.keys()));

      // Step 4: Verify emails
      const verifiedLeads = await this.verifyEmails(decisionMakers);

      if (verifiedLeads.length === 0) {
        console.log('❌ No verified emails found. Cannot continue.');
        return;
      }

      // Step 5: Merge data (only verified leads)
      const mergedLeads = this.mergeJobsAndLeads(verifiedLeads, domainMap);

      if (mergedLeads.length === 0) {
        console.log('❌ No merged leads found. Cannot continue.');
        return;
      }

      // Step 6: Deduplicate
      const { leads: newLeads, decisionMakersMap } = this.deduplicateLeads(mergedLeads, verifiedLeads, domainMap);

      if (newLeads.length === 0) {
        console.log('✅ All leads already processed. Nothing new to send.');
        return;
      }

      // Step 7+8: Generate emails + write CSV + dedup + Instantly (incremental)
      const generated = await this.generateAndExport(newLeads, domainMap, decisionMakersMap, limit);

      console.log('\n✨ Complete workflow finished successfully!');
      console.log('📁 Output files created:');
      console.log('   - output/linkedin_jobs.csv (raw job data)');
      console.log('   - output/decision_makers.csv (all decision makers)');
      console.log('   - output/verified_decision_makers.csv (verified emails only)');
      console.log('   - output/instantly_campaign.csv (final campaign with Claude emails)');
      console.log('   - output/processed_keys.txt (dedup registry)');
      if (this.INSTANTLY_API_KEY) {
        console.log('   - ✅ Leads pushed to Instantly campaign');
      }

      console.log('\n📊 Summary:');
      console.log(`   Jobs scraped: ${jobs.length}`);
      console.log(`   Companies found: ${domainMap.size}`);
      console.log(`   Decision makers: ${decisionMakers.length}`);
      console.log(`   Verified emails: ${verifiedLeads.length}`);
      console.log(`   Merged leads: ${mergedLeads.length}`);
      console.log(`   New (not duped): ${newLeads.length}`);
      console.log(`   Emails generated: ${generated}`);
      console.log(`   Final records: ${generated}`);

    } catch (error) {
      console.error('❌ Complete workflow error:', error);
      throw error;
    }
  }

  /**
   * Quick run with limit
   */
  async quickRun(limit: number = 0): Promise<void> {
    await this.executeCompleteWorkflow(ALL_URLS, limit);
  }
}

export default CompleteWorkflowManager;
export type { JobPost, DecisionMaker, MergedLead, OutreachEmails, InstantlyRecord };
