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
import { US_URLS, EUROPE_URLS, ASIA_URLS, ALL_URLS, REMOTE_URLS } from '../config/urls.js';
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
  companyDescription?: string;
  companyEmployeesCount?: string;
  seniorityLevel?: string;
  jobFunction?: string;
  sourceRegion?: 'us' | 'europe' | 'apac' | 'remote';
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
  email1_subject: string;
  email1_body: string;
  jobPostUrls: string;
  pause_until: string;
  campaignRegion: string;
  campaignTimezone: string;
  campaignId: string;
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
  private readonly TMP_DIR = path.join(process.cwd(), 'tmp');
  private readonly INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY || '';
  private readonly INSTANTLY_CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID || '';
  private readonly CAMPAIGNS = {
    us: {
      id: process.env.INSTANTLY_CAMPAIGN_ID_US || process.env.INSTANTLY_CAMPAIGN_ID || '',
      region: 'US',
      timezone: 'America/New_York'
    },
    europe: {
      id: process.env.INSTANTLY_CAMPAIGN_ID_EUROPE || process.env.INSTANTLY_CAMPAIGN_ID || '',
      region: 'Europe',
      timezone: 'Europe/London'
    },
    apac: {
      id: process.env.INSTANTLY_CAMPAIGN_ID_APAC || process.env.INSTANTLY_CAMPAIGN_ID || '',
      region: 'APAC',
      timezone: 'Asia/Singapore'
    },
    remote: {
      id: process.env.INSTANTLY_CAMPAIGN_ID_REMOTE || process.env.INSTANTLY_CAMPAIGN_ID || '',
      region: 'Remote',
      timezone: 'America/New_York'
    }
  };

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

  private async pollRunStatus(runId: string, label: string, maxWaitMs: number = 2700000): Promise<void> {
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

  private cleanupTmpFiles(): void {
    try {
      if (fs.existsSync(this.TMP_DIR)) {
        const files = fs.readdirSync(this.TMP_DIR);
        for (const file of files) {
          fs.unlinkSync(path.join(this.TMP_DIR, file));
        }
        console.log(`   🧹 Cleaned up ${files.length} temp files from tmp/`);
      }
    } catch (err: any) {
      console.log(`   ⚠️  Could not clean tmp/: ${err.message}`);
    }
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
    const csvPath = path.join(this.TMP_DIR, filename);
    
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
   * Check if there's a successful Jobs Scraper run from today we can reuse.
   * Only reuses if the run's input URL count matches what we'd send (prevents cross-region reuse).
   */
  private async getReusableJobsRun(): Promise<{ datasetId: string; itemCount: number }[]> {
    const results: { datasetId: string; itemCount: number }[] = [];
    try {
      const resp = await axios.get(
        `https://api.apify.com/v2/acts/${this.JOBS_ACTOR}/runs`,
        {
          params: { token: this.apifyToken, limit: 10, desc: true, status: 'SUCCEEDED' },
          timeout: 15000
        }
      );

      const runs = resp.data?.data?.items || [];
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      for (const run of runs) {
        const runDate = (run.finishedAt || run.startedAt || '').slice(0, 10);
        if (runDate !== today || !run.defaultDatasetId) continue;

        // Verify it has items
        const dsResp = await axios.get(
          `https://api.apify.com/v2/datasets/${run.defaultDatasetId}`,
          { params: { token: this.apifyToken }, timeout: 15000 }
        );
        const itemCount = dsResp.data?.data?.itemCount || 0;
        if (itemCount > 0) {
          results.push({ datasetId: run.defaultDatasetId, itemCount });
        }
      }
    } catch (err: any) {
      console.log(`   ⚠️  Could not check for reusable runs: ${err.message}`);
    }
    return results;
  }

  /**
   * Daily region rotation: cycles through US → Europe → APAC → Remote.
   * Returns the URLs for today's region + which campaign to use.
   */
  private readonly REGION_SCHEDULE: Array<{ key: 'us' | 'europe' | 'apac' | 'remote'; label: string; urls: string[] }> = [
    { key: 'us',     label: 'US',     urls: US_URLS },
    { key: 'europe', label: 'Europe', urls: EUROPE_URLS },
    { key: 'apac',   label: 'APAC',   urls: ASIA_URLS },
    { key: 'remote', label: 'Remote', urls: REMOTE_URLS }
  ];

  private readonly MIN_JOBS_TARGET = 15000;
  private todayRegions: Array<typeof this.REGION_SCHEDULE[number]> = [];

  private getPrimaryRegion(): typeof this.REGION_SCHEDULE[number] {
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
    return this.REGION_SCHEDULE[dayOfYear % this.REGION_SCHEDULE.length];
  }

  private getTodayRegion(): typeof this.REGION_SCHEDULE[number] {
    if (this.todayRegions.length > 0) return this.todayRegions[0];
    const primary = this.getPrimaryRegion();
    this.todayRegions = [primary];
    return primary;
  }

  private getNextRegion(): typeof this.REGION_SCHEDULE[number] | null {
    const usedKeys = new Set(this.todayRegions.map(r => r.key));
    const next = this.REGION_SCHEDULE.find(r => !usedKeys.has(r.key));
    if (next) this.todayRegions.push(next);
    return next || null;
  }

  private getCampaignForRegionKey(key: 'us' | 'europe' | 'apac' | 'remote'): { id: string; region: string; timezone: string } {
    return this.CAMPAIGNS[key];
  }

  async scrapeJobs(urls?: string[], count: number = 15000, regionKey?: 'us' | 'europe' | 'apac' | 'remote'): Promise<JobPost[]> {
    console.log('📊 Step 1: Scraping LinkedIn jobs...');

    if (!urls) {
      const region = this.getTodayRegion();
      const campaign = this.CAMPAIGNS[region.key];
      urls = region.urls;
      regionKey = region.key;
      console.log(`🌍 Primary region: ${region.label} (${campaign.timezone}) — ${urls.length} URLs`);
      console.log(`   🎯 Target: ${this.MIN_JOBS_TARGET}+ jobs`);
    } else {
      console.log(`🌍 Using ${urls.length} provided URLs`);
    }

    let datasetId: string;

    // Start a new actor run
    {
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

    const rawJobs = Array.isArray(itemsResponse.data) ? itemsResponse.data : [];
    console.log(`   📦 Raw jobs from Apify: ${rawJobs.length}`);

    const processedJobs = this.filterRawJobs(rawJobs, regionKey);

    await this.saveToCSV(processedJobs, 'linkedin_jobs.csv');
    console.log(`✅ Scraped ${processedJobs.length} real job postings`);
    return processedJobs;
  }

  /**
   * Infer which region a dataset belongs to by sampling job locations.
   * Checks the first 200 jobs and votes on the most common region.
   */
  private inferRegionFromJobs(rawJobs: any[]): 'us' | 'europe' | 'apac' | 'remote' {
    const sample = rawJobs.slice(0, 200);
    const votes = { us: 0, europe: 0, apac: 0, remote: 0 };

    for (const job of sample) {
      const loc = (job.location || '').toLowerCase();

      if (/remote|anywhere|distributed|work from home/i.test(loc) && !/(united states|usa|germany|uk|india|singapore|france|australia)/i.test(loc)) {
        votes.remote++;
      } else if (/united states|usa|\bus\b|new york|california|texas|florida|chicago|boston|seattle|austin|denver|san francisco|los angeles|atlanta|washington|virginia|colorado|massachusetts|oregon|arizona|north carolina|georgia|illinois|ohio|pennsylvania|michigan|new jersey|minnesota|maryland|tennessee|missouri|indiana|wisconsin|connecticut|utah|nevada|hawaii/i.test(loc)) {
        votes.us++;
      } else if (/united kingdom|uk|germany|france|netherlands|spain|italy|sweden|denmark|finland|norway|switzerland|ireland|belgium|portugal|poland|austria|czech|romania|hungary|greece|croatia|london|berlin|paris|amsterdam|munich|barcelona|madrid|milan|vienna|prague|warsaw|lisbon|dublin|brussels|copenhagen|stockholm|oslo|helsinki|zurich/i.test(loc)) {
        votes.europe++;
      } else if (/singapore|japan|south korea|hong kong|india|australia|new zealand|taiwan|malaysia|indonesia|philippines|thailand|vietnam|china|tokyo|sydney|melbourne|bangalore|mumbai|delhi|hyderabad|chennai|pune|seoul|shanghai|beijing|taipei|jakarta|bangkok/i.test(loc)) {
        votes.apac++;
      }
    }

    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    const winner = sorted[0][0] as 'us' | 'europe' | 'apac' | 'remote';
    console.log(`      📊 Location votes: US=${votes.us}, Europe=${votes.europe}, APAC=${votes.apac}, Remote=${votes.remote} → ${winner}`);
    return winner;
  }

  /**
   * Filter raw Apify jobs: remove large companies, agencies, bad keywords/industries.
   * Returns processed JobPost[] ready for the pipeline.
   */
  private filterRawJobs(rawJobs: any[], regionKey?: 'us' | 'europe' | 'apac' | 'remote'): JobPost[] {
    const EXCLUDED_COMPANY_NAMES = [
      'manpower', 'adecco', 'randstad', 'robert half', 'hays',
      'kelly services', 'kforce', 'insight global', 'teksystems', 'tek systems',
      'apex group', 'aerotek', 'allegis', 'express employment', 'spherion',
      'modis', 'volt', 'beacon hill', 'yoh', 'cielo talent',
      'hudson', 'page group', 'pagegroup', 'michael page', 'spencer stuart',
      'korn ferry', 'egon zehnder', 'russell reynolds', 'boyden',
      'harvey nash', 'nigel frank', 'heidrick & struggles', 'heidrick and struggles',
      'talent solutions', 'staffing solutions', 'recruiting solutions',
      'brainworks', 'jobspring', 'cybercoders', 'dice', 'hired',
      'toptal', 'andela', 'crossover', 'turing', 'g2i', 'gun.io',
      'the muse', 'vettery', 'triplebyte',
      'accenture', 'deloitte', 'cognizant', 'infosys', 'wipro', 'tcs',
      'tata consultancy', 'capgemini', 'atos', 'dxc technology', 'unisys',
      'hcl technologies', 'tech mahindra', 'lti mindtree', 'persistent systems',
      'globant', 'epam', 'luxoft', 'endava', 'softserve', 'grid dynamics',
      'thoughtworks', 'slalom', 'avanade', 'publicis sapient',
      'concentrix', 'teleperformance', 'genpact', 'exl service', 'sutherland',
      'conduent', 'firstsource', 'css corp', 'alorica', 'sitel',
      'convergys', 'ttec', 'webhelp', 'majorel'
    ];

    const EXCLUDED_KEYWORDS = [
      'staffing', 'recruiting agency', 'recruitment agency', 'headhunting',
      'headhunter', 'talent agency', 'talent acquisition firm', 'employment agency',
      'search firm', 'executive search', 'placement agency', 'placement firm',
      'temp agency', 'temporary staffing', 'contract staffing',
      'staff augmentation', 'body shop', 'workforce solutions',
      'human capital management', 'talent solutions', 'staffing company',
      'recruiting firm', 'recruitment firm', 'hiring agency',
      'outsourcing', 'outsourced', 'offshoring', 'nearshoring',
      'managed services provider', 'consulting firm'
    ];

    const EXCLUDED_INDUSTRIES = [
      'staffing and recruiting', 'human resources services',
      'outsourcing/offshoring', 'outsourcing and offshoring',
      'professional employer organization'
    ];

    let filteredOut = { large: 0, name: 0, keyword: 0, industry: 0 };

    const filteredJobs = rawJobs.filter((job: any) => {
      const empCount = parseInt(job.companyEmployeesCount || '0', 10);
      if (empCount > 1500) { filteredOut.large++; return false; }

      const companyLower = (job.companyName || '').toLowerCase().trim();
      const descLower = (job.companyDescription || '').toLowerCase();
      const sloganLower = (job.companySlogan || '').toLowerCase();
      const industryRaw = Array.isArray(job.industries)
        ? job.industries.join(' | ').toLowerCase()
        : (job.industries || '').toLowerCase();

      const isKnownAgency = EXCLUDED_COMPANY_NAMES.some(name =>
        companyLower.includes(name) || companyLower.replace(/[^a-z0-9]/g, '').includes(name.replace(/[^a-z0-9]/g, ''))
      );
      if (isKnownAgency) { filteredOut.name++; return false; }

      const allText = `${companyLower} ${sloganLower} ${descLower}`;
      const hasKeyword = EXCLUDED_KEYWORDS.some(kw => allText.includes(kw));
      if (hasKeyword) { filteredOut.keyword++; return false; }

      const isBadIndustry = EXCLUDED_INDUSTRIES.some(ind => industryRaw.includes(ind));
      if (isBadIndustry) { filteredOut.industry++; return false; }

      return true;
    });

    console.log(`   🚫 Filtered out: ${filteredOut.large} large (>1000), ${filteredOut.name} known agencies, ${filteredOut.keyword} by keywords, ${filteredOut.industry} by industry`);
    console.log(`   🔍 After filtering: ${filteredJobs.length} jobs (removed ${rawJobs.length - filteredJobs.length} agencies/large companies)`);

    return filteredJobs.map((job: any) => ({
      title: job.title || '',
      company: job.companyName || job.company || '',
      location: job.location || '',
      companyWebsite: job.companyWebsite || job.companyUrl || '',
      linkedInUrl: job.link || job.jobUrl || job.linkedInUrl || '',
      posted_date: job.postedAt || job.posted_date || '',
      employment_type: job.employmentType || job.contractType || '',
      industry: Array.isArray(job.industries) ? job.industries.join(', ') : (job.industries || job.industry || ''),
      description: job.descriptionText || job.description || '',
      companyDescription: job.companyDescription || '',
      companyEmployeesCount: job.companyEmployeesCount ? String(job.companyEmployeesCount) : '',
      seniorityLevel: job.seniorityLevel || '',
      jobFunction: job.jobFunction || '',
      sourceRegion: regionKey
    }));
  }

  /**
   * Scrape an additional region (called when primary region didn't hit MIN_JOBS_TARGET)
   */
  private async scrapeRegion(region: typeof this.REGION_SCHEDULE[number]): Promise<JobPost[]> {
    console.log(`   🌍 Scraping additional region: ${region.label} (${region.urls.length} URLs)...`);
    const jobs = await this.scrapeJobs(region.urls, 15000, region.key);
    return jobs;
  }

  /**
   * Step 2: Extract company domains
   */
  extractCompanyDomains(jobs: JobPost[]): Map<string, JobPost[]> {
    console.log('🏢 Step 2: Extracting company domains...');
    
    const domainMap = new Map<string, JobPost[]>();
    
    const MAX_JOBS_PER_COMPANY = 3;
    let capped = 0;
    jobs.forEach(job => {
      const domain = this.extractDomain(job.company, job.companyWebsite);
      
      if (!domainMap.has(domain)) {
        domainMap.set(domain, []);
      }

      const existing = domainMap.get(domain)!;
      if (existing.length < MAX_JOBS_PER_COMPANY) {
        existing.push(job);
      } else {
        capped++;
      }
    });

    console.log(`✅ Extracted ${domainMap.size} unique company domains (capped ${capped} excess jobs, max ${MAX_JOBS_PER_COMPANY}/company)`);
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
        leadCount: 50000,
        requireEmail: true,
        emailVerified: true
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
    
    const allLeads: DecisionMaker[] = leads.map(lead => ({
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

    const processedLeads = allLeads;

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
    let byDomain = 0;
    let byName = 0;
    let byFuzzy = 0;

    // Build a secondary index by normalized company name for fast lookup
    const nameMap = new Map<string, JobPost[]>();
    for (const [, jobs] of domainMap.entries()) {
      const name = (jobs[0]?.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (name && !nameMap.has(name)) {
        nameMap.set(name, jobs);
      }
    }

    console.log(`🔍 Checking ${decisionMakers.length} decision makers against ${domainMap.size} domains + ${nameMap.size} company names`);

    decisionMakers.forEach(decisionMaker => {
      const dmCompany = decisionMaker.companyName || '';
      const dmNormalized = dmCompany.toLowerCase().replace(/[^a-z0-9]/g, '');

      // 1. Try exact domain match
      const domain = this.extractDomain(dmCompany);
      let companyJobs = domainMap.get(domain);
      if (companyJobs && companyJobs.length > 0) {
        matches++; byDomain++;
        mergedLeads.push(this.createMergedLead(decisionMaker, companyJobs));
        return;
      }

      // 2. Try normalized company name match
      companyJobs = nameMap.get(dmNormalized);
      if (companyJobs && companyJobs.length > 0) {
        matches++; byName++;
        mergedLeads.push(this.createMergedLead(decisionMaker, companyJobs));
        return;
      }

      // 3. Try fuzzy/partial name match
      const fuzzyMatch = this.findFuzzyMatch(dmCompany, domainMap);
      if (fuzzyMatch) {
        matches++; byFuzzy++;
        mergedLeads.push(this.createMergedLead(decisionMaker, fuzzyMatch.jobs));
        return;
      }
    });

    console.log(`✅ Found ${matches} matches (domain: ${byDomain}, name: ${byName}, fuzzy: ${byFuzzy}), merged ${mergedLeads.length} leads`);
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
      companyDescription: companyJobs[0]?.companyDescription || '',
      companyEmployeesCount: companyJobs[0]?.companyEmployeesCount || '',
      companyIndustries: companyJobs[0]?.industry || '',
      industry: companyJobs[0]?.industry || '',
      openRoles_titles: companyJobs.map(job => job.title).join(' | '),
      openRoles_seniority: companyJobs.map(job => job.seniorityLevel).filter(Boolean).join(' | ') || 'senior',
      openRoles_function: companyJobs.map(job => job.jobFunction).filter(Boolean).join(' | ') || this.extractFunctionFromTitles(companyJobs.map(job => job.title)),
      openRoles_locations: companyJobs.map(job => job.location).join(' | '),
      openRoles_count: companyJobs.length.toString(),
      openRoles_descriptions: companyJobs.slice(0, 3).map(job => (job.description || '').slice(0, 1200)).filter(Boolean).join('\n---\n'),
      personCity: decisionMaker.location?.split(',').map(s => s.trim())[0],
      personCountry: decisionMaker.location?.split(',').map(s => s.trim()).pop(),
      jobPostUrls: companyJobs.map(job => job.linkedInUrl).filter(Boolean) as string[],
      postedDate: companyJobs[0]?.posted_date,
      sourceRegion: companyJobs[0]?.sourceRegion
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

  private getCampaignForLead(lead: MergedLead): { id: string; region: string; timezone: string } {
    const loc = `${lead.openRoles_locations || ''} ${lead.personCountry || ''}`.toLowerCase();

    if (/remote|anywhere|distributed|work from home|wfh/.test(loc)) return this.CAMPAIGNS.remote;

    if (/united states|usa|\bus\b|new york|california|texas|florida|chicago|boston|seattle|austin|denver|san francisco|los angeles|atlanta|washington|virginia|colorado|massachusetts|oregon|arizona|north carolina|georgia|illinois|ohio|pennsylvania|michigan|new jersey|minnesota|maryland|tennessee|missouri|indiana|wisconsin|connecticut|utah|nevada|hawaii/.test(loc)) return this.CAMPAIGNS.us;

    if (/united kingdom|uk|great britain|germany|france|netherlands|spain|italy|sweden|denmark|finland|norway|switzerland|ireland|belgium|portugal|poland|austria|czech|romania|hungary|greece|croatia|slovakia|slovenia|luxembourg|estonia|latvia|lithuania|bulgaria|serbia|ukraine|london|berlin|paris|amsterdam|munich|hamburg|barcelona|madrid|milan|rome|vienna|prague|warsaw|lisbon|dublin|brussels|copenhagen|stockholm|oslo|helsinki|zurich|geneva|manchester|birmingham|edinburgh|glasgow|bristol|leeds|cambridge|oxford|cologne|frankfurt|düsseldorf|stuttgart|lyon|marseille|toulouse|rotterdam|eindhoven|utrecht|antwerp|ghent|porto|krakow|wroclaw|budapest|bucharest/.test(loc)) return this.CAMPAIGNS.europe;

    if (/singapore|japan|south korea|hong kong|india|australia|new zealand|taiwan|malaysia|indonesia|philippines|thailand|vietnam|china|bangladesh|sri lanka|pakistan|myanmar|cambodia|tokyo|sydney|melbourne|bangalore|mumbai|delhi|hyderabad|chennai|pune|kolkata|seoul|shanghai|beijing|shenzhen|guangzhou|taipei|jakarta|bangkok|kuala lumpur|ho chi minh|manila|hanoi|auckland|wellington|osaka|fukuoka|perth|brisbane|adelaide/.test(loc)) return this.CAMPAIGNS.apac;

    // Fallback: use sourceRegion if available, otherwise primary region
    if (lead.sourceRegion && this.CAMPAIGNS[lead.sourceRegion]) {
      return this.CAMPAIGNS[lead.sourceRegion];
    }
    return this.CAMPAIGNS[this.todayRegions[0]?.key || 'us'];
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

    // Pre-deduplicate: keep only 1 lead per company to avoid skip spam
    const seenCompanies = new Set<string>();
    const uniqueLeads = mergedLeads.filter(lead => {
      const key = lead.companyName.toLowerCase().trim();
      if (seenCompanies.has(key)) return false;
      seenCompanies.add(key);
      return true;
    });
    console.log(`   🏢 Pre-dedup: ${mergedLeads.length} → ${uniqueLeads.length} leads (1 per company)`);
    const limitedLeads = limit > 0 ? uniqueLeads.slice(0, limit) : uniqueLeads;
    const csvPath = path.join(this.TMP_DIR, 'instantly_campaign.csv');
    const outputDir = path.dirname(csvPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Write CSV header
    const headers = ['lastName','firstName','companyName','jobTitle','linkedIn','email1_subject','email1_body','jobPostUrls','pause_until','campaignRegion','campaignTimezone','campaignId'];
    fs.writeFileSync(csvPath, headers.join(',') + '\n');

    let generated = 0;
    const instantlyBatch: InstantlyRecord[] = [];
    const BATCH_SIZE = 50;
    const titleCompanySent = new Set<string>();

    for (let i = 0; i < limitedLeads.length; i++) {
      const lead = limitedLeads[i];

      // Only 1 email per unique job title + company combination
      const roleTitles = (lead.openRoles_titles || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
      const companyKey = lead.companyName.toLowerCase().trim();
      const alreadySent = roleTitles.length > 0
        ? roleTitles.every(title => titleCompanySent.has(`${title}__${companyKey}`))
        : titleCompanySent.has(companyKey);
      if (alreadySent) {
        console.log(`   ⏭️  Skipping ${lead.firstName} @ ${lead.companyName} (already contacted for same role+company)`);
        continue;
      }

      console.log(`📧 ${i + 1}/${limitedLeads.length} (generated: ${generated}): ${lead.firstName} ${lead.lastName} @ ${lead.companyName}`);

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
      const campaign = this.getCampaignForLead(lead);

      const record: InstantlyRecord = {
        lastName: lead.lastName,
        firstName: lead.firstName,
        companyName: lead.companyName,
        jobTitle: lead.title,
        linkedIn: dm?.linkedIn || '',
        email1_subject: result.email1_subject,
        email1_body: result.email1_body,
        jobPostUrls: jobUrls.join(' ||| '),
        pause_until: pauseUntil.toISOString(),
        campaignRegion: campaign.region,
        campaignTimezone: campaign.timezone,
        campaignId: campaign.id
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
      // Mark role titles as sent for this company
      if (roleTitles.length > 0) {
        roleTitles.forEach(title => titleCompanySent.add(`${title}__${companyKey}`));
      } else {
        titleCompanySent.add(companyKey);
      }
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
    console.log(`🚀 Step 9: Routing ${records.length} leads to Instantly campaigns...`);

    const recordsByCampaign = new Map<string, InstantlyRecord[]>();
    records.forEach(record => {
      const campaignId = record.campaignId || this.INSTANTLY_CAMPAIGN_ID;
      if (!campaignId) return;
      const campaignRecords = recordsByCampaign.get(campaignId) || [];
      campaignRecords.push(record);
      recordsByCampaign.set(campaignId, campaignRecords);
    });

    if (recordsByCampaign.size === 0) {
      console.log('   ⚠️  No campaign IDs configured. Leads are saved in CSV only.');
      return;
    }

    for (const [campaignId, campaignRecords] of recordsByCampaign.entries()) {
      await this.pushToInstantlyCampaign(campaignId, campaignRecords, decisionMakersMap);
    }
  }

  private async pushToInstantlyCampaign(
    campaignId: string,
    records: InstantlyRecord[],
    decisionMakersMap: Map<string, DecisionMaker>
  ): Promise<void> {
    const sample = records[0];
    console.log(`   ➡️  ${records.length} leads → ${sample.campaignRegion} campaign (${sample.campaignTimezone})`);

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
          email1_subject: record.email1_subject,
          email1_body: record.email1_body,
          jobPostUrls: record.jobPostUrls,
          pause_until: record.pause_until,
          campaignRegion: record.campaignRegion,
          campaignTimezone: record.campaignTimezone
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
            campaign_id: campaignId,
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
      const region = this.getTodayRegion();
      const campaign = this.CAMPAIGNS[region.key];
      console.log('🚀 Starting Complete Workflow: Jobs → Leads → Verify → Dedup → Claude → Instantly\n');
      console.log(`🌍 Region: ${region.label} | Timezone: ${campaign.timezone} | Campaign: ${campaign.id || 'NOT SET'}`);
      console.log(`🔢 Outreach: ${limit > 0 ? limit + ' records' : 'NO LIMIT'}\n`);

      // Step 1: Check for reusable runs from today first
      let jobs: JobPost[] = [];
      const todaysRuns = await this.getReusableJobsRun();
      const coveredRegions = new Set<string>(); // regions already scraped today

      if (todaysRuns.length > 0) {
        const totalItems = todaysRuns.reduce((sum, r) => sum + r.itemCount, 0);
        console.log(`   ♻️  Found ${todaysRuns.length} run(s) from today with ${totalItems} total raw jobs`);
        console.log(`   ✅ Reusing all ${todaysRuns.length} datasets...`);
        for (const run of todaysRuns) {
          console.log(`   📥 Fetching dataset (${run.itemCount} items)...`);
          const itemsResp = await axios.get(
            `https://api.apify.com/v2/datasets/${run.datasetId}/items`,
            { params: { token: this.apifyToken, format: 'json' }, timeout: 120000 }
          );
          const rawJobs = Array.isArray(itemsResp.data) ? itemsResp.data : [];
          // Infer region from job locations
          const inferredRegion = this.inferRegionFromJobs(rawJobs);
          console.log(`   🌍 Inferred region: ${inferredRegion}`);
          coveredRegions.add(inferredRegion);
          const filtered = this.filterRawJobs(rawJobs, inferredRegion as any);
          jobs = [...jobs, ...filtered];
        }
        console.log(`   🔍 After filtering all datasets: ${jobs.length} jobs`);
        console.log(`   🌍 Regions already covered: ${[...coveredRegions].join(', ')}`);
      } else {
        // No reusable runs — scrape primary region
        jobs = await this.scrapeJobs();
        coveredRegions.add(region.key);
      }

      // Scrape remaining regions if below target (skip already covered ones)
      while (jobs.length < this.MIN_JOBS_TARGET) {
        const nextRegion = this.getNextRegion();
        if (!nextRegion) {
          console.log(`   ⚠️  All regions exhausted. Total jobs: ${jobs.length}`);
          break;
        }
        if (coveredRegions.has(nextRegion.key)) {
          console.log(`   ⏭️  Skipping ${nextRegion.label} (already in today's datasets)`);
          continue;
        }
        console.log(`\n   📈 Only ${jobs.length} jobs. Scraping ${nextRegion.label}...`);
        const extraJobs = await this.scrapeRegion(nextRegion);
        jobs = [...jobs, ...extraJobs];
        coveredRegions.add(nextRegion.key);
        console.log(`   ✅ Total jobs now: ${jobs.length}`);
      }

      console.log(`\n🌍 Total: ${jobs.length} filtered jobs`);

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

      // Clean up temporary CSVs (dedup file in output/ persists on volume)
      this.cleanupTmpFiles();

      console.log('\n✨ Complete workflow finished successfully!');
      console.log('📁 Output:');
      console.log('   - output/processed_keys.txt (persistent dedup registry)');
      console.log('   - tmp/ files cleaned up after push');
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
