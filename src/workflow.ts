/**
 * Complete Workflow: LinkedIn Jobs → Leads → Email Sequences
 * 
 * 1. Scrape LinkedIn jobs with company info
 * 2. Extract company domains
 * 3. Scrape decision makers from those domains
 * 4. Generate personalized email sequences
 * 5. Export CSV for Instantly
 */

import { LinkedInJobsTaskRunner } from './linkedin-jobs-task-runner.js';
import { LeadsScraperTaskRunner } from './leads-scraper-task-runner.js';
import { US_URLS } from '../config/urls.js';
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

interface EmailSequence {
  email1_subject: string;
  email1_body: string;
  email2_subject: string;
  email2_body: string;
  email3_subject: string;
  email3_body: string;
  pause_until: string;
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

class WorkflowManager {
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

    const headers = Object.keys(data[0] || {});
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
  async scrapeJobs(urls: string[] = US_URLS): Promise<JobPost[]> {
    console.log('📊 Step 1: Scraping LinkedIn jobs...');
    
    const jobs = await this.jobsRunner.runCustom(urls, {
      scrapeCompany: true,
      count: 100,
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
   * Step 4: Generate personalized email sequences
   */
  private generateEmailSequence(decisionMaker: DecisionMaker, companyJobs: JobPost[]): EmailSequence {
    const firstName = decisionMaker.firstName;
    const companyName = decisionMaker.companyName;
    const jobTitles = companyJobs.map(job => job.title).join(', ');
    const jobUrls = companyJobs.map(job => job.linkedInUrl).filter(Boolean).join(' ||| ');

    const email1_subject = `3 candidates for your ${jobTitles.split(',')[0]} role`;
    
    const email1_body = `hey ${firstName},

seen ${companyName} is hiring a couple senior fullstack engineers. we have a few people in our pipeline right now who match:

- engineer with 7 years building scalable streaming infrastructure at a Series B media tech company
- fullstack lead who scaled backend systems to 10M+ daily active users at a consumer app
- bay area based senior eng with deep experience in audio/content delivery platforms

want me to send over 2-3 anonymized profiles?

Jesse
Upnest Talent`;

    const email2_subject = `Re: 3 candidates for your ${jobTitles.split(',')[0]} role`;
    
    const email2_body = `hey ${firstName},

just wanted to make sure this landed. these are senior folks, active right now, and a real fit for what you're building.

happy to send profiles, no commitment needed.

Jesse
Upnest Talent`;

    const email3_subject = `closing the loop`;
    
    const email3_body = `hey ${firstName},

two of the three candidates i had in mind accepted offers. one is still available and still a strong match for the fullstack role.

worth a look, yes or no?

Jesse
Upnest Talent`;

    // Set pause until 3 days from now
    const pauseUntil = new Date();
    pauseUntil.setDate(pauseUntil.getDate() + 3);

    return {
      email1_subject,
      email1_body,
      email2_subject,
      email2_body,
      email3_subject,
      email3_body,
      pause_until: pauseUntil.toISOString()
    };
  }

  /**
   * Step 5: Create final CSV for Instantly
   */
  async createInstantlyCSV(
    decisionMakers: DecisionMaker[], 
    domainMap: Map<string, JobPost[]>
  ): Promise<void> {
    console.log('📧 Step 4: Creating Instantly CSV...');

    const instantlyRecords: InstantlyRecord[] = [];

    decisionMakers.forEach(decisionMaker => {
      // Find jobs for this company
      const domain = this.extractDomain(decisionMaker.companyName);
      const companyJobs = domainMap.get(domain) || [];
      
      if (companyJobs.length === 0) return; // Skip if no jobs found

      const emailSequence = this.generateEmailSequence(decisionMaker, companyJobs);
      
      const record: InstantlyRecord = {
        lastName: decisionMaker.lastName,
        firstName: decisionMaker.firstName,
        companyName: decisionMaker.companyName,
        jobTitle: decisionMaker.jobTitle,
        linkedIn: decisionMaker.linkedIn || '',
        email1_body: emailSequence.email1_body,
        email2_body: emailSequence.email2_body,
        email3_body: emailSequence.email3_body,
        jobPostUrls: companyJobs.map(job => job.linkedInUrl).filter(Boolean).join(' ||| '),
        pause_until: emailSequence.pause_until,
        email1_subject: emailSequence.email1_subject,
        email2_subject: emailSequence.email2_subject,
        email3_subject: emailSequence.email3_subject
      };

      instantlyRecords.push(record);
    });

    // Save final CSV
    await this.saveToCSV(instantlyRecords, 'instantly_campaign.csv');
    
    console.log(`✅ Created ${instantlyRecords.length} records for Instantly campaign`);
  }

  /**
   * Execute complete workflow
   */
  async executeWorkflow(urls?: string[]): Promise<void> {
    try {
      console.log('🚀 Starting Complete Workflow: Jobs → Leads → Email Sequences\n');

      // Step 1: Scrape jobs
      const jobs = await this.scrapeJobs(urls);

      // Step 2: Extract domains
      const domainMap = this.extractCompanyDomains(jobs);

      // Step 3: Scrape decision makers
      const decisionMakers = await this.scrapeDecisionMakers(Array.from(domainMap.keys()));

      // Step 4: Create Instantly CSV
      await this.createInstantlyCSV(decisionMakers, domainMap);

      console.log('\n✨ Workflow completed successfully!');
      console.log('📁 Output files created:');
      console.log('   - output/linkedin_jobs.csv (raw job data)');
      console.log('   - output/decision_makers.csv (decision maker data)');
      console.log('   - output/instantly_campaign.csv (final campaign data)');

    } catch (error) {
      console.error('❌ Workflow error:', error);
      throw error;
    }
  }

  /**
   * Quick run with default US URLs
   */
  async quickRun(): Promise<void> {
    await this.executeWorkflow(US_URLS);
  }

  /**
   * Custom run with specific URLs
   */
  async customRun(urls: string[]): Promise<void> {
    await this.executeWorkflow(urls);
  }
}

export default WorkflowManager;
export type { JobPost, DecisionMaker, EmailSequence, InstantlyRecord };
