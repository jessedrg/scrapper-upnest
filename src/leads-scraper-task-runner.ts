/**
 * Leads Scraper Task Runner
 * 
 * Specialized runner for the Leads Scraper task
 * Task ID: verifiable_cougar~scrape-desicion-makers
 */

import { ApifyTaskManager, type TaskInput } from './apify-task-manager.js';

export interface LeadsScraperTaskInput extends TaskInput {
  totalResults?: number;
  personTitleIncludes?: string[];
  personTitleExcludes?: string[];
  includeTitleVariants?: boolean;
  seniorityIncludes?: string[];
  seniorityExcludes?: string[];
  functionIncludes?: string[];
  functionExcludes?: string[];
  roleMatchMode?: 'all' | 'any';
  hasEmail?: boolean;
  hasPhone?: boolean;
  emailStatusIncludes?: string[];
  emailStatusExcludes?: string[];
  personFirstNameIncludes?: string[];
  personFirstNameExcludes?: string[];
  personLastNameIncludes?: string[];
  personLastNameExcludes?: string[];
  personLocationCountryIncludes?: string[];
  personLocationCountryExcludes?: string[];
  companyKeywords?: string[];
  companyDomain?: string[];
  companySize?: string[];
  companyRevenueRange?: string[];
  companyFundingRange?: string[];
  companyIndustry?: string[];
  companyTechnologies?: string[];
  companyTechnologiesExcludes?: string[];
  resetProgress?: boolean;
  dontSaveProgress?: boolean;
  customOffset?: number;
}

export class LeadsScraperTaskRunner extends ApifyTaskManager {
  private readonly taskId: string;

  constructor(token?: string) {
    super(token);
    this.taskId = 'verifiable_cougar~scrape-desicion-makers';
  }

  /**
   * Get current task configuration
   */
  async getCurrentConfig(): Promise<TaskInput> {
    return await this.getTaskInput(this.taskId);
  }

  /**
   * Update task configuration
   */
  async updateConfig(config: Partial<LeadsScraperTaskInput>): Promise<void> {
    const currentConfig = await this.getCurrentConfig();
    const updatedConfig = { ...currentConfig, ...config };
    await this.updateTaskInput(this.taskId, updatedConfig);
    console.log('Leads Scraper task configuration updated');
  }

  /**
   * Update company domains
   */
  async updateCompanyDomains(domains: string[]): Promise<void> {
    await this.updateConfig({ companyDomain: domains });
    console.log(`Updated company domains with ${domains.length} entries`);
  }

  /**
   * Add company domains
   */
  async addCompanyDomains(domains: string[]): Promise<void> {
    const currentConfig = await this.getCurrentConfig();
    const existingDomains = currentConfig.companyDomain || [];
    const allDomains = [...new Set([...existingDomains, ...domains])]; // Remove duplicates
    await this.updateConfig({ companyDomain: allDomains });
    console.log(`Added ${domains.length} new company domains (total: ${allDomains.length})`);
  }

  /**
   * Remove company domains
   */
  async removeCompanyDomains(domains: string[]): Promise<void> {
    const currentConfig = await this.getCurrentConfig();
    const existingDomains = currentConfig.companyDomain || [];
    const filteredDomains = existingDomains.filter((domain: string) => !domains.includes(domain));
    await this.updateConfig({ companyDomain: filteredDomains });
    console.log(`Removed ${domains.length} company domains (remaining: ${filteredDomains.length})`);
  }

  /**
   * Update job titles
   */
  async updateJobTitles(titles: { includes?: string[], excludes?: string[] }): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {};
    if (titles.includes) config.personTitleIncludes = titles.includes;
    if (titles.excludes) config.personTitleExcludes = titles.excludes;
    await this.updateConfig(config);
    console.log('Updated job titles configuration');
  }

  /**
   * Update seniority levels
   */
  async updateSeniority(levels: { includes?: string[], excludes?: string[] }): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {};
    if (levels.includes) config.seniorityIncludes = levels.includes;
    if (levels.excludes) config.seniorityExcludes = levels.excludes;
    await this.updateConfig(config);
    console.log('Updated seniority levels configuration');
  }

  /**
   * Update functions/departments
   */
  async updateFunctions(functions: { includes?: string[], excludes?: string[] }): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {};
    if (functions.includes) config.functionIncludes = functions.includes;
    if (functions.excludes) config.functionExcludes = functions.excludes;
    await this.updateConfig(config);
    console.log('Updated functions/departments configuration');
  }

  /**
   * Update company keywords
   */
  async updateCompanyKeywords(keywords: string[]): Promise<void> {
    await this.updateConfig({ companyKeywords: keywords });
    console.log(`Updated company keywords with ${keywords.length} entries`);
  }

  /**
   * Update technologies
   */
  async updateTechnologies(technologies: { includes?: string[], excludes?: string[] }): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {};
    if (technologies.includes) config.companyTechnologies = technologies.includes;
    if (technologies.excludes) config.companyTechnologiesExcludes = technologies.excludes;
    await this.updateConfig(config);
    console.log('Updated technologies configuration');
  }

  /**
   * Update location filters
   */
  async updateLocations(locations: { includes?: string[], excludes?: string[] }): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {};
    if (locations.includes) config.personLocationCountryIncludes = locations.includes;
    if (locations.excludes) config.personLocationCountryExcludes = locations.excludes;
    await this.updateConfig(config);
    console.log('Updated location filters');
  }

  /**
   * Update contact requirements
   */
  async updateContactRequirements(hasEmail?: boolean, hasPhone?: boolean): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {};
    if (hasEmail !== undefined) config.hasEmail = hasEmail;
    if (hasPhone !== undefined) config.hasPhone = hasPhone;
    await this.updateConfig(config);
    console.log('Updated contact requirements');
  }

  /**
   * Update email status filters
   */
  async updateEmailStatus(status: { includes?: string[], excludes?: string[] }): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {};
    if (status.includes) config.emailStatusIncludes = status.includes;
    if (status.excludes) config.emailStatusExcludes = status.excludes;
    await this.updateConfig(config);
    console.log('Updated email status filters');
  }

  /**
   * Update company size and revenue
   */
  async updateCompanyFilters(filters: {
    size?: string[];
    revenue?: string[];
    funding?: string[];
    industry?: string[];
  }): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {};
    if (filters.size) config.companySize = filters.size;
    if (filters.revenue) config.companyRevenueRange = filters.revenue;
    if (filters.funding) config.companyFundingRange = filters.funding;
    if (filters.industry) config.companyIndustry = filters.industry;
    await this.updateConfig(config);
    console.log('Updated company filters');
  }

  /**
   * Run with current configuration
   */
  async run(configOverrides?: Partial<LeadsScraperTaskInput>): Promise<any[]> {
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log('Running Leads Scraper task...');
    return await this.runTaskSyncGetDatasetItems(this.taskId);
  }

  /**
   * Run asynchronously
   */
  async runAsync(configOverrides?: Partial<LeadsScraperTaskInput>): Promise<any> {
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log('Starting asynchronous Leads Scraper run...');
    return await this.runTask(this.taskId);
  }

  /**
   * Get last run results
   */
  async getLastResults(limit?: number): Promise<any[]> {
    return await this.getLastRunDatasetItems(this.taskId, 'SUCCEEDED', limit);
  }

  /**
   * Get task run history
   */
  async getRunHistory(limit: number = 10): Promise<any[]> {
    return await this.getTaskRuns(this.taskId, limit);
  }

  /**
   * Reset task progress
   */
  async resetProgress(): Promise<void> {
    await this.updateConfig({ resetProgress: true });
    console.log('Task progress reset');
  }

  /**
   * Set number of leads to extract
   */
  async setLeadCount(count: number): Promise<void> {
    await this.updateConfig({ totalResults: count });
    console.log(`Set lead extraction count to ${count}`);
  }

  /**
   * Quick setup for decision makers
   */
  async setupDecisionMakers(options: {
    titles?: string[];
    seniority?: string[];
    functions?: string[];
    countries?: string[];
    companyDomains?: string[];
    leadCount?: number;
    requireEmail?: boolean;
    emailVerified?: boolean;
  } = {}): Promise<void> {
    const config: Partial<LeadsScraperTaskInput> = {
      totalResults: options.leadCount || 1000,
      hasEmail: options.requireEmail !== false,
      includeTitleVariants: true,
      roleMatchMode: 'any'
    };

    if (options.titles) config.personTitleIncludes = options.titles;
    if (options.seniority) config.seniorityIncludes = options.seniority;
    if (options.functions) config.functionIncludes = options.functions;
    if (options.countries) config.personLocationCountryIncludes = options.countries;
    if (options.companyDomains) config.companyDomain = options.companyDomains;
    if (options.emailVerified) config.emailStatusIncludes = ['verified'];

    await this.updateConfig(config);
    console.log('Configured for decision makers extraction');
  }
}

export default LeadsScraperTaskRunner;
