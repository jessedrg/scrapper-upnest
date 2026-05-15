/**
 * Basic usage example for LinkedIn Jobs Scraper in TypeScript
 */

import { LinkedInJobsScraper } from '../src/index.js';
import type { JobSearchInput } from '../src/index.js';

async function main() {
  try {
    // Initialize the scraper (make sure APIFY_TOKEN is set in environment)
    const scraper = new LinkedInJobsScraper();
    
    // Example LinkedIn job search URL
    // Go to https://www.linkedin.com/jobs/search/ on incognito window,
    // search with your filters, and copy the URL
    const jobUrls = [
      "https://www.linkedin.com/jobs/search?keywords=software%20engineer&location=United%20States"
    ];
    
    // Create input for the scraper
    const input: JobSearchInput = {
      urls: jobUrls,
      scrapeCompany: true,
      count: 25,
      splitByLocation: false
    };
    
    // Method 1: Get dataset items directly (synchronous)
    console.log("Getting job data directly...");
    const jobs = await scraper.runSyncGetDatasetItems(input);
    
    console.log(`Found ${jobs.length} jobs:`);
    jobs.slice(0, 5).forEach((job: any, index: number) => {
      console.log(`\nJob ${index + 1}:`);
      console.log(`Title: ${job.title || 'N/A'}`);
      console.log(`Company: ${job.company || 'N/A'}`);
      console.log(`Location: ${job.location || 'N/A'}`);
      console.log(`Posted: ${job.posted_date || 'N/A'}`);
    });
    
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
