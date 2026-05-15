/**
 * Scraping Only Script
 * 
 * Runs both Apify jobs without generating outreach:
 * 1. Scrape LinkedIn jobs with company info
 * 2. Scrape decision makers from those companies
 * 3. Generate CSV outputs only
 */

import { LinkedInJobsTaskRunner } from './linkedin-jobs-task-runner.js';
import { LeadsScraperTaskRunner } from './leads-scraper-task-runner.js';
import { US_URLS, EUROPE_URLS, ASIA_URLS, ALL_URLS } from '../config/urls.js';
import * as fs from 'fs';
import * as path from 'path';

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

class ScrapingOnlyManager {
  private jobsRunner: LinkedInJobsTaskRunner;
  private leadsRunner: LeadsScraperTaskRunner;

  constructor(token?: string) {
    this.jobsRunner = new LinkedInJobsTaskRunner(token);
    this.leadsRunner = new LeadsScraperTaskRunner(token);
  }

  /**
   * Extract domain from company website or name
   */
  private extractDomain(company: string, website?: string): string {
    if (website) {
      return website.replace(/^https?:\/\//, '').split('/')[0];
    }
    // Generate domain from company name
    return company.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '') + '.com';
  }

  /**
   * Save data to CSV
   */
  private async saveToCSV(data: any[], filename: string): Promise<void> {
    const csvPath = path.join(process.cwd(), 'output', filename);
    
    // Ensure output directory exists
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
          // Handle commas and quotes in values
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
   * Step 1: Scrape LinkedIn jobs with company information
   */
  async scrapeJobs(urls: string[] = ALL_URLS): Promise<JobPost[]> {
    console.log('📊 Step 1: Scraping LinkedIn jobs...');
    console.log(`🌍 Using ${urls.length} URLs from US, Europe, and Asia`);
    
    const jobs = await this.jobsRunner.runCustom(urls, {
      scrapeCompany: true,
      count: 50, // More URLs, so reduce count per URL to avoid overwhelming
      splitByLocation: false
    });

    const processedJobs: JobPost[] = jobs.map(job => ({
      title: job.title || '',
      company: job.company || '',
      location: job.location || '',
      companyWebsite: job.companyWebsite,
      linkedInUrl: job.linkedInUrl,
      posted_date: job.posted_date,
      employment_type: job.employment_type,
      industry: job.industry,
      description: job.description
    }));

    // Save jobs to CSV
    await this.saveToCSV(processedJobs, 'linkedin_jobs.csv');
    
    console.log(`✅ Scraped ${processedJobs.length} job postings`);
    return processedJobs;
  }

  /**
   * Step 2: Extract unique company domains
   */
  private extractCompanyDomains(jobs: JobPost[]): Map<string, JobPost[]> {
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
   * Step 3: Scrape decision makers from company domains
   */
  async scrapeDecisionMakers(domains: string[]): Promise<DecisionMaker[]> {
    console.log('🎯 Step 3: Scraping decision makers...');
    
    // Update leads scraper with company domains
    await this.leadsRunner.updateCompanyDomains(domains);
    
    // Configure for decision makers
    await this.leadsRunner.setupDecisionMakers({
      titles: ['CEO', 'CTO', 'CFO', 'Co-Founder', 'Founder', 'VP Engineering', 'VP Sales', 'Director'],
      seniority: ['c_suite', 'vp', 'director'],
      functions: ['engineering', 'sales', 'finance'],
      countries: ['United States'],
      leadCount: 200,
      requireEmail: true
    });

    // Run scraper
    const leads = await this.leadsRunner.run();
    
    const processedLeads: DecisionMaker[] = leads.map(lead => ({
      name: lead.name || '',
      firstName: lead.firstName || lead.name?.split(' ')[0] || '',
      lastName: lead.lastName || lead.name?.split(' ').slice(1).join(' ') || '',
      email: lead.email || '',
      jobTitle: lead.title || '',
      companyName: lead.company || '',
      linkedIn: lead.linkedIn || '',
      seniority: lead.seniority,
      function: lead.function,
      location: lead.location
    }));

    // Save leads to CSV
    await this.saveToCSV(processedLeads, 'decision_makers.csv');
    
    console.log(`✅ Found ${processedLeads.length} decision makers`);
    return processedLeads;
  }

  /**
   * Step 4: Create merged data CSV
   */
  async createMergedCSV(
    decisionMakers: DecisionMaker[], 
    domainMap: Map<string, JobPost[]>
  ): Promise<void> {
    console.log('📋 Step 4: Creating merged data CSV...');

    const mergedRecords: any[] = [];

    decisionMakers.forEach(decisionMaker => {
      // Find jobs for this company
      const domain = this.extractDomain(decisionMaker.companyName);
      const companyJobs = domainMap.get(domain) || [];
      
      if (companyJobs.length === 0) return; // Skip if no jobs found

      // Create merged record
      const record = {
        // Decision maker info
        dm_name: decisionMaker.name,
        dm_firstName: decisionMaker.firstName,
        dm_lastName: decisionMaker.lastName,
        dm_email: decisionMaker.email,
        dm_jobTitle: decisionMaker.jobTitle,
        dm_linkedIn: decisionMaker.linkedIn || '',
        dm_seniority: decisionMaker.seniority || '',
        dm_function: decisionMaker.function || '',
        dm_location: decisionMaker.location || '',
        
        // Company info
        company_name: decisionMaker.companyName,
        company_domain: domain,
        
        // Job info
        job_count: companyJobs.length,
        job_titles: companyJobs.map(job => job.title).join(' | '),
        job_locations: companyJobs.map(job => job.location).join(' | '),
        job_urls: companyJobs.map(job => job.linkedInUrl).filter(Boolean).join(' ||| '),
        job_posted_dates: companyJobs.map(job => job.posted_date).filter(Boolean).join(' | '),
        
        // Timestamp
        scraped_at: new Date().toISOString()
      };

      mergedRecords.push(record);
    });

    // Save merged CSV
    await this.saveToCSV(mergedRecords, 'merged_data.csv');
    
    console.log(`✅ Created ${mergedRecords.length} merged records`);
  }

  /**
   * Execute scraping only workflow
   */
  async executeScrapingOnly(urls?: string[]): Promise<void> {
    try {
      console.log('🚀 Starting Scraping Only Workflow: Jobs → Leads → CSV\n');

      // Step 1: Scrape jobs
      const jobs = await this.scrapeJobs(urls);

      // Step 2: Extract domains
      const domainMap = this.extractCompanyDomains(jobs);

      // Step 3: Scrape decision makers
      const decisionMakers = await this.scrapeDecisionMakers(Array.from(domainMap.keys()));

      // Step 4: Create merged CSV
      await this.createMergedCSV(decisionMakers, domainMap);

      console.log('\n✨ Scraping workflow completed successfully!');
      console.log('📁 Output files created:');
      console.log('   - output/linkedin_jobs.csv (raw job data)');
      console.log('   - output/decision_makers.csv (decision maker data)');
      console.log('   - output/merged_data.csv (combined data)');

      // Summary statistics
      console.log('\n📊 Summary:');
      console.log(`   Jobs scraped: ${jobs.length}`);
      console.log(` Companies found: ${domainMap.size}`);
      console.log(` Decision makers: ${decisionMakers.length}`);
      console.log(` Merged records: ${decisionMakers.filter(dm => {
        const domain = this.extractDomain(dm.companyName);
        return domainMap.has(domain);
      }).length}`);

    } catch (error) {
      console.error('❌ Scraping workflow error:', error);
      throw error;
    }
  }

  /**
   * Quick run with all regional URLs
   */
  async quickRun(): Promise<void> {
    await this.executeScrapingOnly(ALL_URLS);
  }

  /**
   * Custom run with specific URLs
   */
  async customRun(urls: string[]): Promise<void> {
    await this.executeScrapingOnly(urls);
  }

  /**
   * Run jobs only (no leads)
   */
  async jobsOnly(urls?: string[]): Promise<void> {
    console.log('📊 Jobs Only Mode');
    await this.scrapeJobs(urls || US_URLS);
    console.log('✅ Jobs scraping completed');
  }

  /**
   * Run leads only (requires existing domains)
   */
  async leadsOnly(domains: string[]): Promise<void> {
    console.log('🎯 Leads Only Mode');
    await this.scrapeDecisionMakers(domains);
    console.log('✅ Leads scraping completed');
  }
}

export default ScrapingOnlyManager;
export type { JobPost, DecisionMaker };
