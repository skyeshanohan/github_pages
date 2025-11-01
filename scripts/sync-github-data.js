#!/usr/bin/env node
/**
 * GitHub Repository Data Sync Script
 * 
 * Efficiently syncs repository metadata from GitHub API while respecting rate limits.
 * 
 * Features:
 * - GitHub App authentication (15,000 requests/hour)
 * - Always full sync (catches pod/codeowners changes)
 * - ETag support for conditional requests
 * - Rate limit handling with exponential backoff
 * - Batch organization listing
 * - Progress tracking
 * 
 * Usage:
 *   node scripts/sync-github-data.js [--org org-name]
 * 
 * Environment Variables (Single Org):
 *   APP_ID: GitHub App ID
 *   APP_PRIVATE_KEY: GitHub App private key (base64 encoded or raw)
 *   ORG_NAME: Organization name (optional, can specify via --org)
 * 
 * Environment Variables (Multiple Orgs):
 *   ORGS_CONFIG: JSON string with org configurations
 *   OR: Use pattern APP_ID_<ORG>, APP_PRIVATE_KEY_<ORG> for each org
 *   ORGS_LIST: Comma-separated list of organization names
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Configuration
const CONFIG = {
    dataFile: path.join(__dirname, '../data/repositories.json'),
    cacheFile: path.join(__dirname, '../data/.github-cache.json'),
    apiBase: 'https://api.github.com',
    rateLimit: {
        // Conservative limits (GitHub App: 15,000/hour, but we'll be careful)
        requestsPerHour: 12000, // Leave buffer
        requestsPerMinute: 200, // Conservative burst limit
        minDelayBetweenRequests: 200, // ms
    },
    incrementalUpdate: false, // Always sync all repos to catch pod/codeowners changes
    maxConcurrent: 5, // Concurrent requests
    retryAttempts: 3,
    retryDelay: 1000, // ms
};

// Rate limiting state
let rateLimitState = {
    remaining: 5000,
    resetAt: Date.now() + 3600000,
    requestsThisMinute: 0,
    lastRequestTime: 0,
};

// GitHub App authentication
let githubToken = null;

/**
 * Generate GitHub App JWT token
 */
function generateAppToken() {
    const appId = process.env.APP_ID;
    const privateKeyBase64 = process.env.APP_PRIVATE_KEY_BASE64;
    const privateKeyRaw = process.env.APP_PRIVATE_KEY;

    if (!appId || (!privateKeyBase64 && !privateKeyRaw)) {
        throw new Error('Missing APP_ID or APP_PRIVATE_KEY environment variables');
    }

    // Handle base64 encoded key
    let privateKey;
    if (privateKeyBase64) {
        privateKey = Buffer.from(privateKeyBase64, 'base64').toString('utf8');
    } else {
        privateKey = privateKeyRaw;
    }

    // For simplicity, we'll use a library if available, otherwise show instructions
    try {
        const jwt = require('jsonwebtoken');
        const now = Math.floor(Date.now() / 1000);
        const token = jwt.sign(
            {
                iat: now - 60, // Issued at time (1 minute ago for clock skew)
                exp: now + (10 * 60), // Expires in 10 minutes
                iss: appId
            },
            privateKey,
            { algorithm: 'RS256' }
        );
        return token;
    } catch (error) {
        console.error('Error generating JWT. Make sure jsonwebtoken is installed:');
        console.error('  npm install jsonwebtoken');
        throw error;
    }
}

/**
 * Get installation token for the organization (legacy, kept for backward compat)
 */
async function getInstallationToken(org) {
    // This is now handled by getInstallationTokenForOrg
    // Keeping for reference but not used in multi-org mode
    throw new Error('Use getInstallationTokenForOrg with orgConfig instead');
}

/**
 * Make GitHub API request with rate limiting
 */
async function githubRequest(method, path, data = null, token = null) {
    const url = `${CONFIG.apiBase}${path}`;
    
    // Rate limiting
    await waitForRateLimit();

    return new Promise((resolve, reject) => {
        const options = {
            method,
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'repository-tracker-sync',
            }
        };

        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        if (data && method !== 'GET') {
            options.headers['Content-Type'] = 'application/json';
        }

        const req = https.request(url, options, (res) => {
            // Update rate limit state
            updateRateLimitState(res.headers);

            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                // Handle rate limiting
                if (res.statusCode === 403 && res.headers['x-ratelimit-remaining'] === '0') {
                    const resetTime = parseInt(res.headers['x-ratelimit-reset']) * 1000;
                    const waitTime = resetTime - Date.now() + 1000; // Add 1 second buffer
                    console.log(`\n⏳ Rate limit reached. Waiting ${Math.ceil(waitTime/1000)} seconds...`);
                    setTimeout(() => {
                        githubRequest(method, path, data, token).then(resolve).catch(reject);
                    }, waitTime);
                    return;
                }

                // Handle errors
                if (res.statusCode >= 400) {
                    const error = new Error(`GitHub API error: ${res.statusCode}`);
                    error.statusCode = res.statusCode;
                    error.body = body;
                    reject(error);
                    return;
                }

                try {
                    const json = body ? JSON.parse(body) : null;
                    resolve(json);
                } catch (e) {
                    resolve(body);
                }
            });
        });

        req.on('error', reject);

        if (data && method !== 'GET') {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

/**
 * Update rate limit state from response headers
 */
function updateRateLimitState(headers) {
    if (headers['x-ratelimit-remaining']) {
        rateLimitState.remaining = parseInt(headers['x-ratelimit-remaining']);
    }
    if (headers['x-ratelimit-reset']) {
        rateLimitState.resetAt = parseInt(headers['x-ratelimit-reset']) * 1000;
    }
}

/**
 * Wait if we're approaching rate limits
 */
async function waitForRateLimit() {
    const now = Date.now();
    
    // Reset minute counter if needed
    if (now - rateLimitState.lastRequestTime > 60000) {
        rateLimitState.requestsThisMinute = 0;
    }

    // Check requests per minute
    if (rateLimitState.requestsThisMinute >= CONFIG.rateLimit.requestsPerMinute) {
        const waitTime = 60000 - (now - (rateLimitState.lastRequestTime - 60000));
        if (waitTime > 0) {
            console.log(`⏸️  Rate limit: waiting ${Math.ceil(waitTime/1000)}s...`);
            await sleep(waitTime);
            rateLimitState.requestsThisMinute = 0;
        }
    }

    // Minimum delay between requests
    const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
    if (timeSinceLastRequest < CONFIG.rateLimit.minDelayBetweenRequests) {
        await sleep(CONFIG.rateLimit.minDelayBetweenRequests - timeSinceLastRequest);
    }

    rateLimitState.lastRequestTime = Date.now();
    rateLimitState.requestsThisMinute++;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load existing repository data
 */
function loadExistingData() {
    try {
        const data = fs.readFileSync(CONFIG.dataFile, 'utf8');
        const json = JSON.parse(data);
        return json.repositories || [];
    } catch (error) {
        console.warn('⚠️  No existing data file found, starting fresh');
        return [];
    }
}

/**
 * Load cache (last sync metadata)
 */
function loadCache() {
    try {
        const cache = fs.readFileSync(CONFIG.cacheFile, 'utf8');
        return JSON.parse(cache);
    } catch (error) {
        return {
            lastSync: null,
            repoETags: {},
            repoLastModified: {}
        };
    }
}

/**
 * Save cache
 */
function saveCache(cache) {
    try {
        fs.writeFileSync(CONFIG.cacheFile, JSON.stringify(cache, null, 2));
    } catch (error) {
        console.warn('⚠️  Could not save cache:', error.message);
    }
}

/**
 * Fetch all repositories for an organization (with pagination)
 */
async function fetchOrganizationRepos(org, token) {
    console.log(`\n📦 Fetching repositories for ${org}...`);
    
    const repos = [];
    let page = 1;
    let hasMore = true;
    let lastResponseHeaders = null;

    while (hasMore) {
        try {
            // We'll make the request and capture headers
            const url = `${CONFIG.apiBase}/orgs/${org}/repos?type=all&per_page=100&page=${page}`;
            
            // Rate limiting
            await waitForRateLimit();

            const response = await new Promise((resolve, reject) => {
                const options = {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'repository-tracker-sync',
                        'Authorization': `Bearer ${token}`
                    }
                };

                const req = https.request(url, options, (res) => {
                    updateRateLimitState(res.headers);
                    lastResponseHeaders = res.headers;

                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 400) {
                            reject(new Error(`GitHub API error: ${res.statusCode}`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });

                req.on('error', reject);
                req.end();
            });

            if (Array.isArray(response)) {
                repos.push(...response);
                console.log(`   Fetched page ${page}: ${response.length} repos (total: ${repos.length})`);
                
                // Check Link header for next page
                const linkHeader = lastResponseHeaders?.link || '';
                hasMore = linkHeader.includes('rel="next"');
                page++;
            } else {
                hasMore = false;
            }
        } catch (error) {
            if (error.message.includes('404')) {
                console.error(`❌ Organization ${org} not found or access denied`);
                hasMore = false;
            } else {
                throw error;
            }
        }
    }

    console.log(`   ✅ Total repositories: ${repos.length}`);
    return repos;
}

/**
 * Fetch CODEQL/Code Scanning alerts for a repository
 */
async function fetchCodeScanningAlerts(owner, repo, token) {
    try {
        const alerts = [];
        let page = 1;
        let hasMore = true;
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Fetch all alerts (open, closed, dismissed) to track opened/closed in last 30 days
        const states = ['open', 'closed', 'dismissed'];
        for (const state of states) {
            page = 1;
            hasMore = true;
            while (hasMore) {
                try {
                    const response = await githubRequest(
                        'GET',
                        `/repos/${owner}/${repo}/code-scanning/alerts?state=${state}&per_page=100&page=${page}`,
                        null,
                        token
                    );
                    
                    if (Array.isArray(response)) {
                        alerts.push(...response);
                        hasMore = response.length === 100;
                        page++;
                    } else {
                        hasMore = false;
                    }
                } catch (error) {
                    if (error.statusCode === 404 || error.statusCode === 403) {
                        hasMore = false;
                    } else {
                        throw error;
                    }
                }
            }
        }

        // Calculate opened/closed in last 30 days
        // Track opened/closed by severity
        const openedBySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        const closedBySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

        alerts.forEach(alert => {
            const severity = (alert.rule?.security_severity_level || alert.rule?.severity || 'medium').toLowerCase();
            const severityKey = ['critical', 'high', 'medium', 'low', 'info'].includes(severity) ? severity : 'medium';
            
            // Check if opened in last 30 days
            if (alert.created_at) {
                const created = new Date(alert.created_at);
                if (created >= thirtyDaysAgo) {
                    openedBySeverity[severityKey]++;
                }
            }
            // Check if closed/dismissed in last 30 days
            const closedDate = alert.closed_at || alert.dismissed_at;
            if (closedDate) {
                const closed = new Date(closedDate);
                if (closed >= thirtyDaysAgo) {
                    closedBySeverity[severityKey]++;
                }
            }
        });

        // Filter only open alerts for severity counts
        const openAlerts = alerts.filter(a => a.state === 'open');
        const closedAlerts = alerts.filter(a => a.state === 'closed' || a.state === 'dismissed');

        // Calculate vulnerability aging (for open alerts)
        const now = new Date();
        let oldestAge = 0;
        let totalAge = 0;
        const ageBuckets = { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 };
        
        openAlerts.forEach(alert => {
            if (alert.created_at) {
                const created = new Date(alert.created_at);
                const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
                oldestAge = Math.max(oldestAge, ageDays);
                totalAge += ageDays;
                
                if (ageDays <= 7) ageBuckets['0-7']++;
                else if (ageDays <= 30) ageBuckets['8-30']++;
                else if (ageDays <= 90) ageBuckets['31-90']++;
                else if (ageDays <= 180) ageBuckets['91-180']++;
                else ageBuckets['180+']++;
            }
        });
        
        const averageAge = openAlerts.length > 0 ? Math.round(totalAge / openAlerts.length) : 0;

        // Calculate MTTR (Mean Time to Remediate) from closed alerts
        let totalRemediationTime = 0;
        let remediationCount = 0;
        
        closedAlerts.forEach(alert => {
            if (alert.created_at && (alert.closed_at || alert.dismissed_at)) {
                const created = new Date(alert.created_at);
                const closed = new Date(alert.closed_at || alert.dismissed_at);
                const daysToRemediate = Math.floor((closed - created) / (1000 * 60 * 60 * 24));
                if (daysToRemediate >= 0) {
                    totalRemediationTime += daysToRemediate;
                    remediationCount++;
                }
            }
        });
        
        const mttr = remediationCount > 0 ? Math.round(totalRemediationTime / remediationCount) : 0;

        // Aggregate by severity (only open alerts)
        const summary = {
            total: openAlerts.length,
            critical: openAlerts.filter(a => {
                const severity = a.rule?.security_severity_level || a.rule?.severity || '';
                return severity.toLowerCase() === 'critical';
            }).length,
            high: openAlerts.filter(a => {
                const severity = a.rule?.security_severity_level || a.rule?.severity || '';
                return severity.toLowerCase() === 'high';
            }).length,
            medium: openAlerts.filter(a => {
                const severity = a.rule?.security_severity_level || a.rule?.severity || '';
                return severity.toLowerCase() === 'medium';
            }).length,
            low: openAlerts.filter(a => {
                const severity = a.rule?.security_severity_level || a.rule?.severity || '';
                return severity.toLowerCase() === 'low';
            }).length,
            openedLast30Days: openedBySeverity.critical + openedBySeverity.high + openedBySeverity.medium + openedBySeverity.low + openedBySeverity.info,
            closedLast30Days: closedBySeverity.critical + closedBySeverity.high + closedBySeverity.medium + closedBySeverity.low + closedBySeverity.info,
            openedLast30DaysBySeverity: openedBySeverity,
            closedLast30DaysBySeverity: closedBySeverity,
            aging: {
                oldestAge: oldestAge,
                averageAge: averageAge,
                ageBuckets: ageBuckets
            },
            mttr: mttr,
            lastUpdated: alerts.length > 0 ? alerts[0].updated_at : null,
            enabled: true
        };

        return summary;
    } catch (error) {
        // Handle 403 (not enabled) or 404 (not found) gracefully
        if (error.statusCode === 403 || error.statusCode === 404) {
            return { 
                total: 0, 
                critical: 0, 
                high: 0, 
                medium: 0, 
                low: 0, 
                openedLast30Days: 0, 
                closedLast30Days: 0,
                openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                aging: { oldestAge: 0, averageAge: 0, ageBuckets: { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 } },
                mttr: 0,
                lastUpdated: null, 
                enabled: false 
            };
        }
        throw error;
    }
}

/**
 * Fetch Dependabot alerts for a repository
 */
async function fetchDependabotAlerts(owner, repo, token) {
    try {
        const alerts = [];
        let page = 1;
        let hasMore = true;
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Fetch all alert states to track opened/closed in last 30 days
        const states = ['open', 'dismissed', 'fixed', 'auto_dismissed'];
        for (const state of states) {
            page = 1;
            hasMore = true;
            while (hasMore) {
                try {
                    const response = await githubRequest(
                        'GET',
                        `/repos/${owner}/${repo}/dependabot/alerts?state=${state}&per_page=100&page=${page}`,
                        null,
                        token
                    );
                    
                    if (Array.isArray(response)) {
                        alerts.push(...response);
                        hasMore = response.length === 100;
                        page++;
                    } else {
                        hasMore = false;
                    }
                } catch (error) {
                    if (error.statusCode === 404 || error.statusCode === 403) {
                        hasMore = false;
                    } else {
                        throw error;
                    }
                }
            }
        }

        // Calculate opened/closed in last 30 days
        // Track opened/closed by severity
        const openedBySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        const closedBySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

        alerts.forEach(alert => {
            const severity = (alert.security_advisory?.severity || 'medium').toLowerCase();
            const severityKey = ['critical', 'high', 'medium', 'low', 'info'].includes(severity) ? severity : 'medium';
            
            // Check if opened in last 30 days
            if (alert.created_at) {
                const created = new Date(alert.created_at);
                if (created >= thirtyDaysAgo) {
                    openedBySeverity[severityKey]++;
                }
            }
            // Check if closed/fixed/dismissed in last 30 days
            const closedDate = alert.dismissed_at || alert.fixed_at;
            if (closedDate) {
                const closed = new Date(closedDate);
                if (closed >= thirtyDaysAgo) {
                    closedBySeverity[severityKey]++;
                }
            }
        });

        // Filter only open alerts for severity counts
        const openAlerts = alerts.filter(a => a.state === 'open');
        const closedAlerts = alerts.filter(a => a.state === 'dismissed' || a.state === 'fixed');

        // Calculate vulnerability aging (for open alerts)
        const now = new Date();
        let oldestAge = 0;
        let totalAge = 0;
        const ageBuckets = { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 };
        
        openAlerts.forEach(alert => {
            if (alert.created_at) {
                const created = new Date(alert.created_at);
                const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
                oldestAge = Math.max(oldestAge, ageDays);
                totalAge += ageDays;
                
                if (ageDays <= 7) ageBuckets['0-7']++;
                else if (ageDays <= 30) ageBuckets['8-30']++;
                else if (ageDays <= 90) ageBuckets['31-90']++;
                else if (ageDays <= 180) ageBuckets['91-180']++;
                else ageBuckets['180+']++;
            }
        });
        
        const averageAge = openAlerts.length > 0 ? Math.round(totalAge / openAlerts.length) : 0;

        // Calculate MTTR (Mean Time to Remediate) from closed alerts
        let totalRemediationTime = 0;
        let remediationCount = 0;
        
        closedAlerts.forEach(alert => {
            if (alert.created_at && (alert.dismissed_at || alert.fixed_at)) {
                const created = new Date(alert.created_at);
                const closed = new Date(alert.dismissed_at || alert.fixed_at);
                const daysToRemediate = Math.floor((closed - created) / (1000 * 60 * 60 * 24));
                if (daysToRemediate >= 0) {
                    totalRemediationTime += daysToRemediate;
                    remediationCount++;
                }
            }
        });
        
        const mttr = remediationCount > 0 ? Math.round(totalRemediationTime / remediationCount) : 0;

        // Aggregate by severity (only open alerts)
        const ecosystems = new Set();
        openAlerts.forEach(alert => {
            if (alert.dependency?.package?.ecosystem) {
                ecosystems.add(alert.dependency.package.ecosystem);
            }
        });

        const summary = {
            total: openAlerts.length,
            critical: openAlerts.filter(a => {
                const severity = a.security_advisory?.severity || '';
                return severity.toLowerCase() === 'critical';
            }).length,
            high: openAlerts.filter(a => {
                const severity = a.security_advisory?.severity || '';
                return severity.toLowerCase() === 'high';
            }).length,
            medium: openAlerts.filter(a => {
                const severity = a.security_advisory?.severity || '';
                return severity.toLowerCase() === 'medium';
            }).length,
            low: openAlerts.filter(a => {
                const severity = a.security_advisory?.severity || '';
                return severity.toLowerCase() === 'low';
            }).length,
            ecosystems: Array.from(ecosystems),
            openedLast30Days: openedBySeverity.critical + openedBySeverity.high + openedBySeverity.medium + openedBySeverity.low + openedBySeverity.info,
            closedLast30Days: closedBySeverity.critical + closedBySeverity.high + closedBySeverity.medium + closedBySeverity.low + closedBySeverity.info,
            openedLast30DaysBySeverity: openedBySeverity,
            closedLast30DaysBySeverity: closedBySeverity,
            aging: {
                oldestAge: oldestAge,
                averageAge: averageAge,
                ageBuckets: ageBuckets
            },
            mttr: mttr,
            lastUpdated: alerts.length > 0 ? alerts[0].updated_at : null,
            enabled: true
        };

        return summary;
    } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 404) {
            return { 
                total: 0, 
                critical: 0, 
                high: 0, 
                medium: 0, 
                low: 0, 
                ecosystems: [], 
                openedLast30Days: 0, 
                closedLast30Days: 0,
                openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                aging: { oldestAge: 0, averageAge: 0, ageBuckets: { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 } },
                mttr: 0,
                lastUpdated: null, 
                enabled: false 
            };
        }
        throw error;
    }
}

/**
 * Fetch Secret Scanning alerts for a repository
 */
async function fetchSecretScanningAlerts(owner, repo, token) {
    try {
        const alerts = [];
        let page = 1;
        let hasMore = true;
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Fetch both open and resolved alerts to track opened/closed in last 30 days
        const states = ['open', 'resolved'];
        for (const state of states) {
            page = 1;
            hasMore = true;
            while (hasMore) {
                try {
                    const response = await githubRequest(
                        'GET',
                        `/repos/${owner}/${repo}/secret-scanning/alerts?state=${state}&per_page=100&page=${page}`,
                        null,
                        token
                    );
                    
                    if (Array.isArray(response)) {
                        alerts.push(...response);
                        hasMore = response.length === 100;
                        page++;
                    } else {
                        hasMore = false;
                    }
                } catch (error) {
                    if (error.statusCode === 404 || error.statusCode === 403) {
                        hasMore = false;
                    } else {
                        throw error;
                    }
                }
            }
        }

        // Calculate opened/closed in last 30 days
        let openedLast30Days = 0;
        let closedLast30Days = 0;

        alerts.forEach(alert => {
            // Check if opened in last 30 days
            if (alert.created_at) {
                const created = new Date(alert.created_at);
                if (created >= thirtyDaysAgo) {
                    openedLast30Days++;
                }
            }
            // Check if resolved in last 30 days
            if (alert.resolved_at) {
                const resolved = new Date(alert.resolved_at);
                if (resolved >= thirtyDaysAgo) {
                    closedLast30Days++;
                }
            }
        });

        // Filter only open alerts for secret type counts
        const openAlerts = alerts.filter(a => a.state === 'open');
        const closedAlerts = alerts.filter(a => a.state === 'resolved');

        // Calculate vulnerability aging (for open alerts)
        const now = new Date();
        let oldestAge = 0;
        let totalAge = 0;
        const ageBuckets = { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 };
        
        openAlerts.forEach(alert => {
            if (alert.created_at) {
                const created = new Date(alert.created_at);
                const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
                oldestAge = Math.max(oldestAge, ageDays);
                totalAge += ageDays;
                
                if (ageDays <= 7) ageBuckets['0-7']++;
                else if (ageDays <= 30) ageBuckets['8-30']++;
                else if (ageDays <= 90) ageBuckets['31-90']++;
                else if (ageDays <= 180) ageBuckets['91-180']++;
                else ageBuckets['180+']++;
            }
        });
        
        const averageAge = openAlerts.length > 0 ? Math.round(totalAge / openAlerts.length) : 0;

        // Calculate MTTR (Mean Time to Remediate) from closed alerts
        let totalRemediationTime = 0;
        let remediationCount = 0;
        
        closedAlerts.forEach(alert => {
            if (alert.created_at && alert.resolved_at) {
                const created = new Date(alert.created_at);
                const resolved = new Date(alert.resolved_at);
                const daysToRemediate = Math.floor((resolved - created) / (1000 * 60 * 60 * 24));
                if (daysToRemediate >= 0) {
                    totalRemediationTime += daysToRemediate;
                    remediationCount++;
                }
            }
        });
        
        const mttr = remediationCount > 0 ? Math.round(totalRemediationTime / remediationCount) : 0;

        // Aggregate by secret type (only open alerts)
        const secretTypes = {};
        openAlerts.forEach(alert => {
            const type = alert.secret_type || 'unknown';
            secretTypes[type] = (secretTypes[type] || 0) + 1;
        });

        return {
            total: openAlerts.length,
            secretTypes: secretTypes,
            openedLast30Days: openedLast30Days,
            closedLast30Days: closedLast30Days,
            openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, // Secrets don't have severity
            closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, // Secrets don't have severity
            aging: {
                oldestAge: oldestAge,
                averageAge: averageAge,
                ageBuckets: ageBuckets
            },
            mttr: mttr,
            lastUpdated: alerts.length > 0 ? alerts[0].updated_at : null,
            enabled: true
        };
    } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 404) {
            return { 
                total: 0, 
                secretTypes: {}, 
                openedLast30Days: 0, 
                closedLast30Days: 0,
                openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                aging: { oldestAge: 0, averageAge: 0, ageBuckets: { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 } },
                mttr: 0,
                lastUpdated: null, 
                enabled: false 
            };
        }
        throw error;
    }
}

/**
 * Enrich repository data with additional metadata (always fetched to catch changes)
 */
async function enrichRepository(repo, cache, token) {
    const cacheKey = `${repo.owner.login}/${repo.name}`;

    try {
        // Always fetch detailed repo info to catch pod/codeowners changes
        // Include custom properties in the response
        const detailedRepo = await githubRequest(
            'GET',
            `/repos/${repo.owner.login}/${repo.name}`,
            null,
            token
        );
        // Ensure topics is always defined for downstream logic
        const topics = Array.isArray(detailedRepo.topics) ? detailedRepo.topics : [];
        
        // Also try to fetch custom properties if they exist (separate endpoint for custom properties)
        // Note: This might require the custom properties API which is newer
        let customProperties = null;
        try {
            // Try to get custom properties - this might not be available in all GitHub orgs
            // Custom properties API endpoint (if available)
            const customPropsResponse = await githubRequest(
                'GET',
                `/repos/${repo.owner.login}/${repo.name}/properties/values`,
                null,
                token
            );
            if (customPropsResponse && Array.isArray(customPropsResponse)) {
                // Convert array format to object: [{property_name: "Pod", value: "..."}, ...] -> {Pod: "..."}
                customProperties = {};
                customPropsResponse.forEach(prop => {
                    if (prop.property_name && prop.value) {
                        customProperties[prop.property_name] = prop.value;
                    }
                });
            }
        } catch (customPropsError) {
            // Custom properties API might not be available or enabled - that's okay
            // Fall back to topics or other methods
        }

        // Note: We always fetch to catch pod/codeowners changes, so no lastModified cache

        // Extract custom properties
        // GitHub repositories can have custom properties set at the org level
        let pod = null;
        let environmentType = null;
        
        // Method 1: Check custom properties (from separate API call if available)
        if (customProperties) {
            // Custom properties format: { "Pod": "Vertical3-Pod2", "EnvironmentType": "Prod" }
            pod = customProperties.Pod || customProperties.pod || customProperties.POD || null;
            environmentType = customProperties.EnvironmentType || customProperties.environmentType || customProperties.ENVIRONMENTTYPE || null;
        }
        
        // Method 1b: Check if custom properties are in the repo response itself
        if (!pod && detailedRepo.custom_properties) {
            pod = detailedRepo.custom_properties.Pod || detailedRepo.custom_properties.pod || detailedRepo.custom_properties.POD || pod;
            environmentType = detailedRepo.custom_properties.EnvironmentType || detailedRepo.custom_properties.environmentType || detailedRepo.custom_properties.ENVIRONMENTTYPE || environmentType;
        }
        
        // Method 2: Check topics (fallback if custom properties not set)
        if (!pod) {
            // Look for pod in topics (could be prefixed with "pod:" or match pattern "Vertical-Pod")
            const podTopic = topics.find(topic => {
                const lower = topic.toLowerCase();
                return lower.includes('pod:') || (topic.includes('-') && topic.length > 5);
            });
            if (podTopic) {
                // If it has "pod:" prefix, extract after colon, otherwise use as-is
                pod = podTopic.includes(':') ? podTopic.split(':')[1].trim() : podTopic;
            }
        }
        
        // Method 3: Try fetching custom properties via API if not in response
        // This would require checking if the response includes custom_properties
        // If not, we could make an additional API call, but that's expensive
        
        // Extract vertical from pod name (format: "Vertical3-Pod2" -> vertical = "Vertical3")
        let vertical = null;
        if (pod && pod.includes('-')) {
            const parts = pod.split('-');
            // Take everything before the last "-" as vertical
            // For "Vertical3-Pod2", vertical = "Vertical3"
            vertical = parts.slice(0, -1).join('-');
        }

        // Detect CODEOWNERS in default locations
        let codeowners = false;
        const codeownersPaths = [
            '.github/CODEOWNERS',
            'CODEOWNERS',
            'docs/CODEOWNERS'
        ];
        for (const p of codeownersPaths) {
            try {
                await githubRequest('GET', `/repos/${repo.owner.login}/${repo.name}/contents/${encodeURIComponent(p)}`, null, token);
                codeowners = true; // If request succeeds, file exists
                break;
            } catch (e) {
                // continue trying other locations
            }
        }
        
        // Skip archived repositories - only process active repositories
        if (detailedRepo.archived) {
            return null;
        }
        
        // Fetch vulnerability data
        let codeScanning, dependabot, secretScanning;
        try {
            codeScanning = await fetchCodeScanningAlerts(repo.owner.login, repo.name, token);
        } catch (error) {
            console.warn(`⚠️  Failed to fetch CODEQL alerts for ${repo.owner.login}/${repo.name}: ${error.message}`);
            codeScanning = { 
                total: 0, 
                critical: 0, 
                high: 0, 
                medium: 0, 
                low: 0, 
                openedLast30Days: 0, 
                closedLast30Days: 0,
                openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                aging: { oldestAge: 0, averageAge: 0, ageBuckets: { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 } },
                mttr: 0,
                lastUpdated: null, 
                enabled: false 
            };
        }
        
        try {
            dependabot = await fetchDependabotAlerts(repo.owner.login, repo.name, token);
        } catch (error) {
            console.warn(`⚠️  Failed to fetch Dependabot alerts for ${repo.owner.login}/${repo.name}: ${error.message}`);
            dependabot = { 
                total: 0, 
                critical: 0, 
                high: 0, 
                medium: 0, 
                low: 0, 
                ecosystems: [], 
                openedLast30Days: 0, 
                closedLast30Days: 0,
                openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                aging: { oldestAge: 0, averageAge: 0, ageBuckets: { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 } },
                mttr: 0,
                lastUpdated: null, 
                enabled: false 
            };
        }
        
        try {
            secretScanning = await fetchSecretScanningAlerts(repo.owner.login, repo.name, token);
        } catch (error) {
            console.warn(`⚠️  Failed to fetch Secret Scanning alerts for ${repo.owner.login}/${repo.name}: ${error.message}`);
            secretScanning = { 
                total: 0, 
                secretTypes: {}, 
                openedLast30Days: 0, 
                closedLast30Days: 0,
                openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                aging: { oldestAge: 0, averageAge: 0, ageBuckets: { '0-7': 0, '8-30': 0, '31-90': 0, '91-180': 0, '180+': 0 } },
                mttr: 0,
                lastUpdated: null, 
                enabled: false 
            };
        }
        
        return {
            organization: repo.owner.login,
            repository: repo.name,
            pod: pod || 'No Pod Selected', // Default to "No Pod Selected" if not found
            environmentType: environmentType || '',
            vertical: vertical || '', // Extracted from pod, or empty
            description: detailedRepo.description || '',
            language: detailedRepo.language || '',
            status: detailedRepo.disabled ? 'deprecated' : 'active',
            lastActivity: detailedRepo.updated_at ? detailedRepo.updated_at.split('T')[0] : null,
            githubUrl: detailedRepo.html_url,
            // Keep existing ownership data (engineeringManager) - we'll merge later
            _metadata: {
                stars: detailedRepo.stargazers_count,
                forks: detailedRepo.forks_count,
                openIssues: detailedRepo.open_issues_count,
                createdAt: detailedRepo.created_at,
                pushedAt: detailedRepo.pushed_at,
                defaultBranch: detailedRepo.default_branch,
                topics: topics, // Store topics for reference
            },
            codeowners: codeowners,
            vulnerabilities: {
                codeScanning: codeScanning,
                dependabot: dependabot,
                secretScanning: secretScanning
            }
        };
    } catch (error) {
        if (error.statusCode === 304) {
            // Not modified - skip
            return null;
        }
        console.warn(`⚠️  Failed to fetch details for ${repo.owner.login}/${repo.name}: ${error.message}`);
        return null;
    }
}

/**
 * Merge GitHub data with existing ownership data
 */
function mergeWithOwnership(githubData, existingRepos) {
    const existingMap = new Map();
    existingRepos.forEach(repo => {
        const key = `${repo.organization}/${repo.repository}`;
        existingMap.set(key, repo);
    });

    return githubData.map(repo => {
        const key = `${repo.organization}/${repo.repository}`;
        const existing = existingMap.get(key);

        if (existing) {
            // Merge: prefer new values when provided, otherwise keep existing
            return {
                ...existing,
                // Update pod from GitHub if available and not "No Pod Selected", otherwise use existing, otherwise default
                pod: (repo.pod && repo.pod !== 'No Pod Selected') ? repo.pod : (existing.pod || 'No Pod Selected'),
                environmentType: repo.environmentType || existing.environmentType || '',
                vertical: repo.vertical || existing.vertical || '',
                description: repo.description || existing.description,
                language: repo.language || existing.language,
                status: repo.status || existing.status,
                lastActivity: repo.lastActivity || existing.lastActivity,
                githubUrl: repo.githubUrl || existing.githubUrl,
                // Preserve engineeringManager from existing (not in GitHub API)
                engineeringManager: existing.engineeringManager || '',
                codeowners: typeof repo.codeowners === 'boolean' ? repo.codeowners : (existing.codeowners || false),
                // Merge vulnerability data (prefer new, but keep existing structure if new is missing)
                vulnerabilities: repo.vulnerabilities || existing.vulnerabilities || {
                    codeScanning: { 
                        total: 0, 
                        critical: 0, 
                        high: 0, 
                        medium: 0, 
                        low: 0, 
                        openedLast30Days: 0, 
                        closedLast30Days: 0,
                        openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        lastUpdated: null, 
                        enabled: false 
                    },
                    dependabot: { 
                        total: 0, 
                        critical: 0, 
                        high: 0, 
                        medium: 0, 
                        low: 0, 
                        ecosystems: [], 
                        openedLast30Days: 0, 
                        closedLast30Days: 0,
                        openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        lastUpdated: null, 
                        enabled: false 
                    },
                    secretScanning: { 
                        total: 0, 
                        secretTypes: {}, 
                        openedLast30Days: 0, 
                        closedLast30Days: 0,
                        openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        lastUpdated: null, 
                        enabled: false 
                    }
                },
            };
        } else {
            // New repo - return with pod/vertical if extracted
            return {
                ...repo,
                // Ensure pod defaults to "No Pod Selected" if empty
                pod: repo.pod || 'No Pod Selected',
                // Ensure engineeringManager field exists (will be empty, can be added manually)
                engineeringManager: repo.engineeringManager || '',
                codeowners: typeof repo.codeowners === 'boolean' ? repo.codeowners : false,
                // Ensure vulnerabilities structure exists
                vulnerabilities: repo.vulnerabilities || {
                    codeScanning: { 
                        total: 0, 
                        critical: 0, 
                        high: 0, 
                        medium: 0, 
                        low: 0, 
                        openedLast30Days: 0, 
                        closedLast30Days: 0,
                        openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        lastUpdated: null, 
                        enabled: false 
                    },
                    dependabot: { 
                        total: 0, 
                        critical: 0, 
                        high: 0, 
                        medium: 0, 
                        low: 0, 
                        ecosystems: [], 
                        openedLast30Days: 0, 
                        closedLast30Days: 0,
                        openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        lastUpdated: null, 
                        enabled: false 
                    },
                    secretScanning: { 
                        total: 0, 
                        secretTypes: {}, 
                        openedLast30Days: 0, 
                        closedLast30Days: 0,
                        openedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        closedLast30DaysBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        lastUpdated: null, 
                        enabled: false 
                    }
                },
            };
        }
    });
}

/**
 * Get organization configurations
 */
function getOrganizationConfigs() {
    // Option 1: JSON config string
    if (process.env.ORGS_CONFIG) {
        try {
            return JSON.parse(process.env.ORGS_CONFIG);
        } catch (error) {
            throw new Error('Invalid ORGS_CONFIG JSON format');
        }
    }

    // Option 2: Comma-separated list with per-org secrets
    if (process.env.ORGS_LIST) {
        const orgs = process.env.ORGS_LIST.split(',').map(org => org.trim()).filter(Boolean);
        return orgs.map(org => {
            const normalizedOrg = org.toUpperCase().replace(/[^A-Z0-9]/g, '_');
            const appId = process.env[`APP_ID_${normalizedOrg}`];
            const privateKey = process.env[`APP_PRIVATE_KEY_${normalizedOrg}`];
            
            if (!appId || !privateKey) {
                throw new Error(`Missing APP_ID_${normalizedOrg} or APP_PRIVATE_KEY_${normalizedOrg} for org: ${org}`);
            }

            return {
                name: org,
                appId: appId,
                privateKey: privateKey,
                privateKeyBase64: process.env[`APP_PRIVATE_KEY_${normalizedOrg}_BASE64`]
            };
        });
    }

    // Option 3: Single org (backward compatible)
    const org = process.env.ORG_NAME;
    if (org && process.env.APP_ID && process.env.APP_PRIVATE_KEY) {
        return [{
            name: org,
            appId: process.env.APP_ID,
            privateKey: process.env.APP_PRIVATE_KEY,
            privateKeyBase64: process.env.APP_PRIVATE_KEY_BASE64
        }];
    }

    return null;
}

/**
 * Get app token for a specific organization config
 */
function generateAppTokenForOrg(orgConfig) {
    const appId = orgConfig.appId;
    const privateKeyBase64 = orgConfig.privateKeyBase64;
    const privateKeyRaw = orgConfig.privateKey;

    if (!appId || (!privateKeyBase64 && !privateKeyRaw)) {
        throw new Error(`Missing app credentials for org: ${orgConfig.name}`);
    }

    // Handle base64 encoded key
    let privateKey;
    if (privateKeyBase64) {
        privateKey = Buffer.from(privateKeyBase64, 'base64').toString('utf8');
    } else {
        privateKey = privateKeyRaw;
    }

    try {
        const jwt = require('jsonwebtoken');
        const now = Math.floor(Date.now() / 1000);
        const token = jwt.sign(
            {
                iat: now - 60,
                exp: now + (10 * 60),
                iss: appId
            },
            privateKey,
            { algorithm: 'RS256' }
        );
        return token;
    } catch (error) {
        console.error('Error generating JWT. Make sure jsonwebtoken is installed:');
        console.error('  npm install jsonwebtoken');
        throw error;
    }
}

/**
 * Get installation token for an organization using org config
 */
async function getInstallationTokenForOrg(org, orgConfig) {
    const appToken = generateAppTokenForOrg(orgConfig);

    // Get installation ID
    const installations = await githubRequest('GET', '/app/installations', null, appToken);
    
    // Try case-sensitive match first
    let installation = installations.find(inst => inst.account.login === org);
    
    // If not found, try case-insensitive match
    if (!installation) {
        installation = installations.find(inst => 
            inst.account.login && inst.account.login.toLowerCase() === org.toLowerCase()
        );
    }
    
    // Debug: log available installations if not found
    if (!installation) {
        const availableOrgs = installations.map(inst => ({
            login: inst.account.login,
            type: inst.account.type,
            id: inst.id
        }));
        console.error(`Available installations: ${JSON.stringify(availableOrgs, null, 2)}`);
        console.error(`Looking for organization: ${org}`);
        throw new Error(`GitHub App not installed for organization: ${org}. Available installations: ${availableOrgs.map(o => o.login).join(', ')}`);
    }

    // Get installation token
    const response = await githubRequest(
        'POST',
        `/app/installations/${installation.id}/access_tokens`,
        {},
        appToken
    );

    return response.token;
}

/**
 * Sync a single organization (always full sync to catch all changes)
 */
async function syncSingleOrganization(orgConfig, existingRepos, cache) {
    const org = orgConfig.name;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📦 Syncing organization: ${org}`);
    console.log(`${'='.repeat(60)}`);

    // Authenticate
    const installationToken = await getInstallationTokenForOrg(org, orgConfig);

    // Fetch all repositories
    const githubRepos = await fetchOrganizationRepos(org, installationToken);
    console.log(`📊 Found ${githubRepos.length} repositories`);

    // Enrich repositories
    console.log('\n🔄 Enriching repository data...');
    const enrichedRepos = [];
    let skipped = 0;
    let updated = 0;
    let errors = 0;

    // Process in batches
    const batchSize = CONFIG.maxConcurrent;
    for (let i = 0; i < githubRepos.length; i += batchSize) {
        const batch = githubRepos.slice(i, i + batchSize);
        const batchPromises = batch.map(async (repo) => {
            try {
                const enriched = await enrichRepository(repo, cache, installationToken);
                if (enriched) {
                    enrichedRepos.push(enriched);
                    updated++;
                } else {
                    skipped++;
                }
            } catch (error) {
                console.error(`❌ Error enriching ${repo.owner.login}/${repo.name}:`, error.message);
                errors++;
            }
        });

        await Promise.all(batchPromises);

        // Progress update
        const processed = Math.min(i + batchSize, githubRepos.length);
        console.log(`   Progress: ${processed}/${githubRepos.length} (${updated} updated, ${skipped} skipped, ${errors} errors)`);
    }

    console.log(`✅ ${org}: Updated ${updated}, skipped ${skipped}, errors ${errors}`);

    return {
        org: org,
        repos: enrichedRepos,
        stats: { updated, skipped, errors }
    };
}

/**
 * Main sync function
 */
async function syncRepositories(options = {}) {
    const singleOrg = options.org;

    // Get organization configurations
    let orgConfigs;
    
    if (singleOrg) {
        // Single org mode (backward compatible or --org flag)
        const appId = process.env.APP_ID;
        const privateKey = process.env.APP_PRIVATE_KEY;
        
        if (!appId || !privateKey) {
            throw new Error('Missing APP_ID or APP_PRIVATE_KEY for single org mode');
        }

        orgConfigs = [{
            name: singleOrg,
            appId: appId,
            privateKey: privateKey,
            privateKeyBase64: process.env.APP_PRIVATE_KEY_BASE64
        }];
    } else {
        // Multi-org mode
        orgConfigs = getOrganizationConfigs();
        
        if (!orgConfigs || orgConfigs.length === 0) {
            throw new Error(
                'Organization configuration required. Options:\n' +
                '  1. Set ORGS_CONFIG (JSON array)\n' +
                '  2. Set ORGS_LIST and APP_ID_<ORG>, APP_PRIVATE_KEY_<ORG> secrets\n' +
                '  3. Set ORG_NAME, APP_ID, APP_PRIVATE_KEY for single org\n' +
                '  4. Use --org flag with APP_ID and APP_PRIVATE_KEY'
            );
        }
    }

    console.log('🚀 Starting GitHub repository sync (full sync always enabled)...');
    console.log(`   Organizations: ${orgConfigs.map(c => c.name).join(', ')}`);
    console.log(`   Mode: Full sync (always fetches all repos to catch pod/codeowners changes)`);

    // Load existing data
    const existingRepos = loadExistingData();
    const cache = loadCache();

    // Sync each organization
    const allEnrichedRepos = [];
    const orgStats = [];

    for (const orgConfig of orgConfigs) {
        try {
            const result = await syncSingleOrganization(orgConfig, existingRepos, cache);
            allEnrichedRepos.push(...result.repos);
            orgStats.push(result.stats);
        } catch (error) {
            console.error(`\n❌ Failed to sync ${orgConfig.name}:`, error.message);
            orgStats.push({
                org: orgConfig.name,
                updated: 0,
                skipped: 0,
                errors: 1
            });
        }
    }

    // Merge with existing ownership data
    const mergedRepos = mergeWithOwnership(allEnrichedRepos, existingRepos);

    // Remove duplicates (in case same repo exists in multiple orgs)
    const uniqueRepos = Array.from(
        new Map(mergedRepos.map(repo => [`${repo.organization}/${repo.repository}`, repo])).values()
    );

    // Update cache
    cache.lastSync = new Date().toISOString();
    saveCache(cache);

    // Calculate totals
    const totals = orgStats.reduce((acc, stat) => ({
        updated: acc.updated + (stat.updated || 0),
        skipped: acc.skipped + (stat.skipped || 0),
        errors: acc.errors + (stat.errors || 0)
    }), { updated: 0, skipped: 0, errors: 0 });

    // Save updated data
    const output = {
        metadata: {
            lastUpdated: new Date().toISOString(),
            version: '2.0',
            source: 'GitHub API sync',
            syncedAt: new Date().toISOString(),
            organizations: orgConfigs.map(c => c.name),
            totalRepos: uniqueRepos.length,
            updated: totals.updated,
            skipped: totals.skipped,
            errors: totals.errors,
            orgStats: orgStats
        },
        repositories: uniqueRepos
    };

    // Backup existing file
    if (fs.existsSync(CONFIG.dataFile)) {
        const backupFile = CONFIG.dataFile.replace('.json', `.backup.${Date.now()}.json`);
        fs.copyFileSync(CONFIG.dataFile, backupFile);
        console.log(`\n💾 Backed up existing data to ${backupFile}`);
    }

    // Write new data
    fs.writeFileSync(CONFIG.dataFile, JSON.stringify(output, null, 2));
    
    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ Sync complete!');
    console.log(`   Organizations: ${orgConfigs.length}`);
    console.log(`   Total repositories: ${uniqueRepos.length}`);
    console.log(`   Updated: ${totals.updated}`);
    console.log(`   Skipped: ${totals.skipped}`);
    console.log(`   Errors: ${totals.errors}`);
    console.log(`   Rate limit remaining: ${rateLimitState.remaining} requests`);
    console.log(`   Data saved to ${CONFIG.dataFile}`);

    return output;
}

// CLI handling
if (require.main === module) {
    const args = process.argv.slice(2);
    const options = {
        org: args.find(arg => arg.startsWith('--org='))?.split('=')[1] || process.env.GITHUB_ORG,
        full: args.includes('--full')
    };

    syncRepositories(options)
        .then(() => {
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Sync failed:', error.message);
            console.error(error.stack);
            process.exit(1);
        });
}

module.exports = { syncRepositories };

