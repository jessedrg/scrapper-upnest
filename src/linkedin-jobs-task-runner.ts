/**
 * LinkedIn Jobs Task Runner
 * 
 * Specialized runner for the LinkedIn Jobs Scraper task
 * Task ID: verifiable_cougar~job-posts-24h-usa
 */

import { ApifyTaskManager, type TaskInput } from './apify-task-manager.js';
import { US_URLS, EUROPE_URLS, ASIA_URLS, REMOTE_URLS, ALL_URLS } from '../config/urls.js';

export interface LinkedInJobsTaskInput {
  urls: string[];
  scrapeCompany?: boolean;
  count?: number;
  splitByLocation?: boolean;
  splitCountry?: string;
}

export class LinkedInJobsTaskRunner extends ApifyTaskManager {
  private readonly taskId: string;

  constructor(token?: string) {
    super(token);
    this.taskId = 'verifiable_cougar~job-posts-24h-usa';
  }

  /**
   * Get current task configuration
   */
  async getCurrentConfig(): Promise<TaskInput> {
    return await this.getTaskInput(this.taskId);
  }

  /**
   * Update task URLs
   */
  async updateUrls(urls: string[]): Promise<void> {
    const currentConfig = await this.getCurrentConfig();
    const updatedConfig = { ...currentConfig, urls };
    await this.updateTaskInput(this.taskId, updatedConfig);
    console.log(`Updated task with ${urls.length} URLs`);
  }

  /**
   * Update task configuration
   */
  async updateConfig(config: Partial<LinkedInJobsTaskInput>): Promise<void> {
    const currentConfig = await this.getCurrentConfig();
    const updatedConfig = { ...currentConfig, ...config };
    await this.updateTaskInput(this.taskId, updatedConfig);
    console.log('Task configuration updated');
  }

  /**
   * Run with US URLs
   */
  async runUS(configOverrides?: Partial<LinkedInJobsTaskInput>): Promise<any[]> {
    await this.updateUrls(US_URLS);
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log('Running LinkedIn Jobs scraper for US positions...');
    return await this.runTaskSyncGetDatasetItems(this.taskId);
  }

  /**
   * Run with European URLs
   */
  async runEurope(configOverrides?: Partial<LinkedInJobsTaskInput>): Promise<any[]> {
    await this.updateUrls(EUROPE_URLS);
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log('Running LinkedIn Jobs scraper for European positions...');
    return await this.runTaskSyncGetDatasetItems(this.taskId);
  }

  /**
   * Run with Asian URLs
   */
  async runAsia(configOverrides?: Partial<LinkedInJobsTaskInput>): Promise<any[]> {
    await this.updateUrls(ASIA_URLS);
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log('Running LinkedIn Jobs scraper for Asian positions...');
    return await this.runTaskSyncGetDatasetItems(this.taskId);
  }

  /**
   * Run with Remote URLs
   */
  async runRemote(configOverrides?: Partial<LinkedInJobsTaskInput>): Promise<any[]> {
    await this.updateUrls(REMOTE_URLS);
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log('Running LinkedIn Jobs scraper for Remote positions...');
    return await this.runTaskSyncGetDatasetItems(this.taskId);
  }

  /**
   * Run with all URLs
   */
  async runAll(configOverrides?: Partial<LinkedInJobsTaskInput>): Promise<any[]> {
    await this.updateUrls(ALL_URLS);
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log('Running LinkedIn Jobs scraper for all regions...');
    return await this.runTaskSyncGetDatasetItems(this.taskId);
  }

  /**
   * Run with custom URLs
   */
  async runCustom(urls: string[], configOverrides?: Partial<LinkedInJobsTaskInput>): Promise<any[]> {
    await this.updateUrls(urls);
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log(`Running LinkedIn Jobs scraper with ${urls.length} custom URLs...`);
    return await this.runTaskSyncGetDatasetItems(this.taskId);
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
   * Run task asynchronously
   */
  async runAsync(configOverrides?: Partial<LinkedInJobsTaskInput>): Promise<any> {
    if (configOverrides) {
      await this.updateConfig(configOverrides);
    }
    
    console.log('Starting asynchronous LinkedIn Jobs scraper run...');
    return await this.runTask(this.taskId);
  }
}

export default LinkedInJobsTaskRunner;
