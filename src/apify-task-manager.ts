/**
 * Apify Task Manager
 * 
 * A comprehensive client for managing Apify tasks including:
 * - Running existing tasks
 * - Updating task configurations
 * - Getting task information and results
 * - Managing task inputs and outputs
 */

import axios from 'axios';
import type { AxiosResponse } from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

export interface TaskInput {
  [key: string]: any;
}

export interface TaskRun {
  id: string;
  actId: string;
  userId: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  meta: {
    origin: string;
    userAgent: string;
  };
  stats: {
    inputBodyLen: number;
    rebootCount: number;
    restartCount: number;
    resurrectCount: number;
    computeUnits: number;
  };
  options: {
    build: string;
    timeoutSecs: number;
    memoryMbytes: number;
    diskMbytes: number;
  };
  buildId: string;
  defaultKeyValueStoreId: string;
  defaultDatasetId: string;
  defaultRequestQueueId: string;
  buildNumber: string;
  containerUrl?: string;
  usage: any;
  usageTotalUsd: number;
  usageUsd: any;
}

export interface TaskInfo {
  id: string;
  actId: string;
  userId: string;
  createdAt: string;
  modifiedAt: string;
  name: string;
  input: TaskInput;
  options: {
    build: string;
    timeoutSecs: number;
    memoryMbytes: number;
  };
  actName: string;
  actVersion?: string;
}

export class ApifyTaskManager {
  private token: string;
  private baseUrl: string;

  constructor(token?: string) {
    this.token = token || process.env.APIFY_TOKEN || '';
    if (!this.token) {
      throw new Error('API token is required. Set APIFY_TOKEN environment variable or pass token parameter');
    }
    
    this.baseUrl = 'https://api.apify.com/v2';
  }

  private async makeRequest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', endpoint: string, data?: any): Promise<AxiosResponse> {
    const url = `${this.baseUrl}${endpoint}`;
    const params = { token: this.token };
    
    const config = {
      method,
      url,
      params,
      data,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    
    return await axios(config);
  }

  /**
   * Get task information
   */
  async getTask(taskId: string): Promise<TaskInfo> {
    const response = await this.makeRequest('GET', `/actor-tasks/${taskId}`);
    return response.data;
  }

  /**
   * Get task input configuration
   */
  async getTaskInput(taskId: string): Promise<TaskInput> {
    const response = await this.makeRequest('GET', `/actor-tasks/${taskId}/input`);
    return response.data;
  }

  /**
   * Update task input configuration
   */
  async updateTaskInput(taskId: string, input: TaskInput): Promise<TaskInput> {
    const response = await this.makeRequest('PUT', `/actor-tasks/${taskId}/input`, input);
    return response.data;
  }

  /**
   * Update entire task configuration
   */
  async updateTask(taskId: string, taskData: Partial<TaskInfo>): Promise<TaskInfo> {
    const response = await this.makeRequest('PUT', `/actor-tasks/${taskId}`, taskData);
    return response.data;
  }

  /**
   * Run a task
   */
  async runTask(taskId: string, inputOverrides?: TaskInput): Promise<TaskRun> {
    const response = await this.makeRequest('POST', `/actor-tasks/${taskId}/runs`, inputOverrides);
    return response.data.data;
  }

  /**
   * Run a task synchronously (wait for completion)
   */
  async runTaskSync(taskId: string, inputOverrides?: TaskInput): Promise<any> {
    const response = await this.makeRequest('POST', `/actor-tasks/${taskId}/run-sync`, inputOverrides);
    return response.data;
  }

  /**
   * Run a task synchronously and get dataset items
   */
  async runTaskSyncGetDatasetItems(taskId: string, inputOverrides?: TaskInput): Promise<any[]> {
    const response = await this.makeRequest('POST', `/actor-tasks/${taskId}/run-sync-get-dataset-items`, inputOverrides);
    return response.data;
  }

  /**
   * Get task runs
   */
  async getTaskRuns(taskId: string, limit?: number, offset?: number): Promise<TaskRun[]> {
    const params: any = {};
    if (limit) params.limit = limit;
    if (offset) params.offset = offset;

    const response = await this.makeRequest('GET', `/actor-tasks/${taskId}/runs`);
    return response.data.data;
  }

  /**
   * Get last run
   */
  async getLastRun(taskId: string, status?: string): Promise<TaskRun> {
    const params: any = {};
    if (status) params.status = status;

    const response = await this.makeRequest('GET', `/actor-tasks/${taskId}/runs/last`);
    return response.data;
  }

  /**
   * Get last run dataset items
   */
  async getLastRunDatasetItems(taskId: string, status?: string, limit?: number, offset?: number): Promise<any[]> {
    const params: any = {};
    if (status) params.status = status;
    if (limit) params.limit = limit;
    if (offset) params.offset = offset;

    const response = await this.makeRequest('GET', `/actor-tasks/${taskId}/runs/last/dataset/items`);
    return response.data;
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<void> {
    await this.makeRequest('DELETE', `/actor-tasks/${taskId}`);
  }

  /**
   * Get task webhooks
   */
  async getTaskWebhooks(taskId: string): Promise<any[]> {
    const response = await this.makeRequest('GET', `/actor-tasks/${taskId}/webhooks`);
    return response.data;
  }
}

export default ApifyTaskManager;
