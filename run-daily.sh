#!/bin/bash
# Daily LinkedIn scraper + outreach workflow
# Runs at 9:00 AM Spain time via cron

cd /Users/jesse.dragstra/CascadeProjects/linkedin-jobs-scraper

# Load nvm/node
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Run the complete workflow
npm run complete >> output/cron.log 2>&1

echo "$(date): Workflow completed" >> output/cron.log
