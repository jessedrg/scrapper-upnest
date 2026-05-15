/**
 * Complete Workflow Example with Claude Integration
 * 
 * Full end-to-end workflow:
 * 1. Scrape LinkedIn jobs (real data via Apify actor)
 * 2. Scrape decision makers from those companies
 * 3. Verify emails via Million Verifier
 * 4. Merge jobs + leads (only verified)
 * 5. Deduplicate (skip already-processed combos)
 * 6. Generate personalized 3-email sequences with Claude
 * 7. Export final CSV for Instantly
 *
 * Run: npm run complete
 */

import CompleteWorkflowManager from '../src/complete-workflow.js';

async function main() {
  const workflow = new CompleteWorkflowManager();
  
  try {
    // Run complete workflow with no limits
    await workflow.quickRun(0);
    
  } catch (error) {
    console.error('❌ Complete workflow failed:', error);
  }
}

main().catch(console.error);
