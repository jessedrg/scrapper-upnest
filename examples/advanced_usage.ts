/**
 * Advanced usage example for LinkedIn Jobs Scraper in TypeScript
 */

import { LinkedInJobsScraper } from '../src/index.js';
import type { JobSearchInput, CountryCode } from '../src/index.js';

async function main() {
  try {
    // Initialize the scraper
    const scraper = new LinkedInJobsScraper();
    
    // Example with multiple search URLs and location splitting
    const jobUrls = [
      "https://www.linkedin.com/jobs/search?keywords=data%20scientist&location=United%20States",
      "https://www.linkedin.com/jobs/search?keywords=machine%20learning&location=United%20States"
    ];
    
    // Example 1: Run with location splitting for US cities
    console.log("=== Example 1: Location splitting for US ===");
    const inputSplit: JobSearchInput = {
      urls: jobUrls,
      scrapeCompany: true,
      count: 50,
      splitByLocation: true,
      splitCountry: 'US' as CountryCode
    };
    
    try {
      // Get run information first
      const runInfo = await scraper.run(inputSplit);
      console.log(`Run started with ID: ${runInfo.id}`);
      console.log(`Status: ${runInfo.status}`);
      console.log(`Estimated cost: $${runInfo.usageTotalUsd.toFixed(6)}`);
      
      // Then get the actual data
      const jobs = await scraper.runSyncGetDatasetItems(inputSplit);
      console.log(`Found ${jobs.length} jobs with location splitting`);
      
    } catch (error) {
      console.error("Error with location splitting:", error);
    }
    
    // Example 2: Simple synchronous run
    console.log("\n=== Example 2: Simple synchronous run ===");
    const inputSimple: JobSearchInput = {
      urls: ["https://www.linkedin.com/jobs/search?keywords=python%20developer&location=New%20York"],
      scrapeCompany: false,  // Faster without company details
      count: 10,
      splitByLocation: false
    };
    
    try {
      // Get output from key-value store
      const output = await scraper.runSync(inputSimple);
      console.log("Run output:");
      console.log(JSON.stringify(output, null, 2));
      
    } catch (error) {
      console.error("Error with simple run:", error);
    }
    
  } catch (error) {
    console.error("Initialization error:", error);
  }
}

main().catch(console.error);
