/**
 * LinkedIn Jobs Scraper API Client
 * 
 * A TypeScript client for the Apify LinkedIn Jobs Scraper API.
 */

import axios from 'axios';
import type { AxiosResponse } from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// Types based on OpenAPI specification
export type CountryCode = 'US' | 'CA' | 'MX' | 'GB' | 'DE' | 'FR' | 'NL' | 'CH' | 'SE' | 'NO' | 'DK' | 'FI' | 'IE' | 'ES' | 'IT' | 'PT' | 'BE' | 'AT' | 'PL' | 'CZ' | 'RO' | 'HU' | 'GR' | 'BG' | 'HR' | 'RS' | 'UA' | 'SK' | 'LT' | 'LV' | 'EE' | 'SI' | 'LU' | 'MT' | 'IS' | 'CY' | 'TR' | 'RU' | 'GE' | 'AM' | 'AZ' | 'BY' | 'BA' | 'XK' | 'MD' | 'ME' | 'MK' | 'AL' | 'MC' | 'AD' | 'LI' | 'SM' | 'VA' | 'IN' | 'CN' | 'JP' | 'KR' | 'SG' | 'HK' | 'TW' | 'TH' | 'VN' | 'ID' | 'MY' | 'PH' | 'BD' | 'PK' | 'LK' | 'NP' | 'MM' | 'KH' | 'KZ' | 'UZ' | 'KG' | 'TJ' | 'TM' | 'MN' | 'BN' | 'MV' | 'BT' | 'LA' | 'TL' | 'AF' | 'KP' | 'AE' | 'SA' | 'IL' | 'QA' | 'KW' | 'BH' | 'OM' | 'JO' | 'LB' | 'IQ' | 'IR' | 'PS' | 'SY' | 'YE' | 'AU' | 'NZ' | 'FJ' | 'PG' | 'WS' | 'TO' | 'VU' | 'SB' | 'KI' | 'MH' | 'FM' | 'PW' | 'NR' | 'TV' | 'BR' | 'AR' | 'CO' | 'CL' | 'PE' | 'EC' | 'UY' | 'VE' | 'BO' | 'PY' | 'GY' | 'SR' | 'CR' | 'PA' | 'GT' | 'DO' | 'PR' | 'JM' | 'TT' | 'HN' | 'SV' | 'NI' | 'BS' | 'BB' | 'CU' | 'HT' | 'BZ' | 'AG' | 'DM' | 'GD' | 'LC' | 'KN' | 'VC' | 'ZA' | 'NG' | 'KE' | 'EG' | 'MA' | 'GH' | 'ET' | 'TZ' | 'RW' | 'UG' | 'SN' | 'TN' | 'CI' | 'CM' | 'DZ' | 'AO' | 'MU' | 'ZM' | 'ZW' | 'MZ' | 'CD' | 'BW' | 'NA' | 'MG' | 'LY' | 'SD' | 'SS' | 'SO' | 'ML' | 'GA' | 'BJ' | 'BF' | 'MW' | 'NE' | 'TD' | 'SL' | 'LR' | 'ER' | 'GM' | 'GN' | 'GW' | 'TG' | 'MR' | 'SZ' | 'LS' | 'DJ' | 'CG' | 'CF' | 'BI' | 'CV' | 'KM' | 'GQ' | 'ST' | 'SC';

export interface JobSearchInput {
  urls: string[];
  scrapeCompany?: boolean;
  count?: number;
  splitByLocation?: boolean;
  splitCountry?: CountryCode;
}

export interface Usage {
  ACTOR_COMPUTE_UNITS: number;
  DATASET_READS: number;
  DATASET_WRITES: number;
  KEY_VALUE_STORE_READS: number;
  KEY_VALUE_STORE_WRITES: number;
  KEY_VALUE_STORE_LISTS: number;
  REQUEST_QUEUE_READS: number;
  REQUEST_QUEUE_WRITES: number;
  DATA_TRANSFER_INTERNAL_GBYTES: number;
  DATA_TRANSFER_EXTERNAL_GBYTES: number;
  PROXY_RESIDENTIAL_TRANSFER_GBYTES: number;
  PROXY_SERPS: number;
}

export interface UsageUsd {
  ACTOR_COMPUTE_UNITS: number;
  DATASET_READS: number;
  DATASET_WRITES: number;
  KEY_VALUE_STORE_READS: number;
  KEY_VALUE_STORE_WRITES: number;
  KEY_VALUE_STORE_LISTS: number;
  REQUEST_QUEUE_READS: number;
  REQUEST_QUEUE_WRITES: number;
  DATA_TRANSFER_INTERNAL_GBYTES: number;
  DATA_TRANSFER_EXTERNAL_GBYTES: number;
  PROXY_RESIDENTIAL_TRANSFER_GBYTES: number;
  PROXY_SERPS: number;
}

export interface RunResponse {
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
  usage: Usage;
  usageTotalUsd: number;
  usageUsd: UsageUsd;
}

export interface ApiResponse<T> {
  data: T;
}

export class LinkedInJobsScraper {
  private token: string;
  private baseUrl: string;
  private actorName: string;

  constructor(token?: string) {
    this.token = token || process.env.APIFY_TOKEN || '';
    if (!this.token) {
      throw new Error('API token is required. Set APIFY_TOKEN environment variable or pass token parameter');
    }
    
    this.baseUrl = 'https://api.apify.com/v2';
    this.actorName = 'curious_coder~linkedin-jobs-scraper';
  }

  private async makeRequest(endpoint: string, data: JobSearchInput): Promise<AxiosResponse> {
    const url = `${this.baseUrl}${endpoint}`;
    const params = { token: this.token };
    
    return await axios.post(url, data, { params });
  }

  /**
   * Execute Actor, wait for completion, and return dataset items
   */
  async runSyncGetDatasetItems(input: JobSearchInput): Promise<any[]> {
    this.validateInput(input);
    const endpoint = `/acts/${this.actorName}/run-sync-get-dataset-items`;
    const response = await this.makeRequest(endpoint, input);
    return response.data;
  }

  /**
   * Execute Actor and return information about the initiated run
   */
  async run(input: JobSearchInput): Promise<RunResponse> {
    this.validateInput(input);
    const endpoint = `/acts/${this.actorName}/runs`;
    const response = await this.makeRequest(endpoint, input);
    return (response.data as ApiResponse<RunResponse>).data;
  }

  /**
   * Execute Actor, wait for completion, and return OUTPUT from Key-value store
   */
  async runSync(input: JobSearchInput): Promise<any> {
    this.validateInput(input);
    const endpoint = `/acts/${this.actorName}/run-sync`;
    const response = await this.makeRequest(endpoint, input);
    return response.data;
  }

  private validateInput(input: JobSearchInput): void {
    if (!input.urls || input.urls.length === 0) {
      throw new Error('urls array is required and cannot be empty');
    }
    
    if (input.splitByLocation && !input.splitCountry) {
      throw new Error('splitCountry is required when splitByLocation is true');
    }
    
    if (input.count && input.count < 10) {
      throw new Error('count must be at least 10');
    }
  }
}

export default LinkedInJobsScraper;

// Export task managers
export { ApifyTaskManager } from './apify-task-manager.js';
export { LinkedInJobsTaskRunner } from './linkedin-jobs-task-runner.js';
export { LeadsScraperTaskRunner } from './leads-scraper-task-runner.js';
