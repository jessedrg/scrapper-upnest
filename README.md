# LinkedIn Jobs → Decision Makers → Email Sequences

A complete TypeScript workflow that scrapes LinkedIn job postings, extracts company domains, finds decision makers, and generates personalized email sequences for outreach campaigns.

## 🔄 Workflow Overview

1. **Scrape LinkedIn Jobs** - Extract job postings with company information
2. **Extract Company Domains** - Get unique company domains from job data
3. **Find Decision Makers** - Scrape contact info for CEOs, CTOs, VPs, etc.
4. **Generate Email Sequences** - Create personalized 3-email sequences
5. **Export CSV** - Generate final CSV for Instantly email campaigns

## 🚀 Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment:**
   ```bash
   cp .env.example .env
   # Add your APIFY_TOKEN to .env
   ```

3. **Run the workflow:**
   ```bash
   npm run workflow
   ```

## 📁 Output Files

The workflow generates 3 CSV files in the `output/` directory:

- `linkedin_jobs.csv` - Raw job posting data
- `decision_makers.csv` - Decision maker contact information  
- `instantly_campaign.csv` - Final campaign data for Instantly

## 📧 Email Sequence Format

Each campaign record includes a 3-email sequence:

**Email 1:** Initial outreach with candidate profiles
**Email 2:** Follow-up to ensure delivery
**Email 3:** Closing the loop with availability update

## 🎯 Target Roles

The workflow targets these decision makers:
- CEOs, CTOs, CFOs
- Co-Founders, Founders  
- VP Engineering, VP Sales
- Directors and Managers

## 🏢 Company Sources

Uses comprehensive LinkedIn job search URLs covering:
- **US Markets** - 18+ tech role searches
- **European Markets** - 27+ countries
- **Asian Markets** - 20+ countries  
- **Remote Positions** - Global remote roles

## 📊 CSV Structure

### Instantly Campaign CSV Fields:
- `firstName`, `lastName` - Contact name
- `companyName`, `jobTitle` - Company info
- `linkedIn` - LinkedIn profile URL
- `email1_subject`, `email1_body` - First email
- `email2_subject`, `email2_body` - Follow-up email  
- `email3_subject`, `email3_body` - Final email
- `jobPostUrls` - Related job postings
- `pause_until` - Send timing

## 🛠 Customization

### Custom Job URLs
```typescript
import WorkflowManager from './src/workflow.js';

const workflow = new WorkflowManager();
const customUrls = [
  "https://www.linkedin.com/jobs/search?keywords=react%20developer&location=United%20States"
];

await workflow.customRun(customUrls);
```

### Modify Email Templates
Edit the `generateEmailSequence` method in `src/workflow.ts` to customize messaging.

## 📋 Requirements

- Node.js 16+
- Apify API token
- TypeScript

## 🔧 Development

```bash
# Build TypeScript
npm run build

# Run workflow
npm run workflow
```

## 📄 License

ISC
