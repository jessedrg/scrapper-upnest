/**
 * Main Workflow Example
 * 
 * Complete end-to-end workflow:
 * 1. Scrape LinkedIn jobs with company info
 * 2. Extract company domains
 * 3. Scrape decision makers
 * 4. Generate email sequences
 * 5. Export CSV for Instantly
 */

import WorkflowManager from '../src/workflow.js';

async function main() {
  console.log('🚀 LinkedIn Jobs → Decision Makers → Email Sequences\n');
  
  const workflow = new WorkflowManager();
  
  try {
    // Execute complete workflow
    await workflow.quickRun();
    
    console.log('\n✨ Workflow completed successfully!');
    console.log('📁 Check the output/ directory for:');
    console.log('   - linkedin_jobs.csv');
    console.log('   - decision_makers.csv'); 
    console.log('   - instantly_campaign.csv');
    
  } catch (error) {
    console.error('❌ Workflow failed:', error);
  }
}

main().catch(console.error);
