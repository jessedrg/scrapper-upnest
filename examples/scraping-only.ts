/**
 * Scraping Only Example
 * 
 * Runs both Apify jobs without generating outreach:
 * - LinkedIn jobs scraping
 * - Decision makers scraping
 * - CSV outputs only
 */

import ScrapingOnlyManager from '../src/scraping-only.js';

async function main() {
  console.log('🚀 Scraping Only: LinkedIn Jobs + Decision Makers\n');
  
  const scraper = new ScrapingOnlyManager();
  
  try {
    // Run complete scraping workflow
    await scraper.quickRun();
    
    console.log('\n✨ Scraping completed successfully!');
    console.log('📁 Check the output/ directory for:');
    console.log('   - linkedin_jobs.csv');
    console.log('   - decision_makers.csv'); 
    console.log('   - merged_data.csv');
    
  } catch (error) {
    console.error('❌ Scraping failed:', error);
  }
}

main().catch(console.error);
