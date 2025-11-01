// Repository Ownership Tracker - Main JavaScript Module
// Features: Sorting, Filtering, Export, Deep Linking, Caching, etc.

class RepositoryTracker {
    constructor() {
        this.allRepos = [];
        this.filteredRepos = [];
        this.currentSort = { column: null, direction: 'asc' };
        this.activeFilters = {
            organizations: [],
            pods: [],
            verticals: [],
            managers: [],
            status: [],
            search: '',
            noPod: false,
            // Advanced filters
            timeFilters: {
                recent7Days: false,
                recent14Days: false,
                activeMonth: false,
                active60Days: false,
                activeQuarter: false,
                active180Days: false,
                active365Days: false,
                stale90: false
            },
            healthFilters: {
                missingManager: false,
                noActivityDate: false,
                missingLanguage: false,
                multiplePods: false
            },
            securityFilters: {
                critical: false,
                high: false,
                medium: false,
                codeql: false,
                dependabot: false,
                secrets: false,
                secure: false
            },
            topAttributes: {
                languages: [],
                pods: [],
                verticals: []
            }
        };
        this.currentPage = 1;
        this.itemsPerPage = 50;
        this.viewMode = 'table'; // 'table' or 'grouped'
        this.darkMode = localStorage.getItem('darkMode') === 'true';
        this.cacheKey = 'repo_data_cache';
        this.cacheTimestampKey = 'repo_data_timestamp';
        this.cacheMaxAge = 5 * 60 * 1000; // 5 minutes
        
        // Debounce timer
        this.searchDebounceTimer = null;
        
        // Pod -> Engineering Manager mapping
        this.podManagers = {};
        
        // Cache DOM elements for performance
        this.domCache = {};
        
        this.init();
    }
    
    getElement(id) {
        if (!this.domCache[id]) {
            this.domCache[id] = document.getElementById(id);
        }
        return this.domCache[id];
    }

    async init() {
        // Show UI immediately
        this.applyTheme();
        this.setupEventListeners();
        
        // Load pod manager map FIRST so managers are available before first render
        try { await this.loadPodManagers(); } catch {}
        
        // Load data
            this.loadStateFromURL();
            this.loadData().then(() => {
            // Render is already called in onDataLoaded
        });
    }

    async loadPodManagers() {
        try {
            const res = await fetch('data/pod-managers.yaml');
            if (!res.ok) return;
            const yaml = await res.text();
            this.podManagers = this.parseSimpleYamlMap(yaml);
            // If repositories are present, apply mapping and update
            if (this.allRepos && this.allRepos.length) {
                this.applyPodManagers();
                this.applyFilters();
                this.render();
                this.updateFilterChips();
            }
        } catch (e) {
            // Ignore if file missing
        }
    }

    parseSimpleYamlMap(text) {
        const map = {};
        if (!text) return map;
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf(':');
            if (idx === -1) continue;
            const key = trimmed.slice(0, idx).trim();
            let value = trimmed.slice(idx + 1).trim();
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
            if (key) map[key] = value;
        }
        return map;
    }

    normalizeRepositories(repos) {
        // Normalize data (ensure fields have expected shapes)
        // Filter out archived repositories - only process active repositories
        return (repos || []).filter(repo => repo.status !== 'archived').map(repo => {
            const normalized = { ...repo };
            
            // Pod may be an array from sync; handle it properly
            let podArray = [];
            if (Array.isArray(normalized.pod)) {
                podArray = normalized.pod.filter(p => p && p.trim() && p !== 'No Pod Selected');
            } else if (typeof normalized.pod === 'string') {
                // Handle comma-separated pods
                podArray = normalized.pod.split(',').map(p => p.trim()).filter(p => p && p !== 'No Pod Selected');
            }
            
            // Set primary pod (first meaningful one)
            normalized.pod = podArray.length > 0 ? podArray[0] : 'No Pod Selected';
            
            // Store all pods for manager lookup
            normalized._allPods = podArray;
            
            // Derive all verticals from all pods
            const allVerticals = new Set();
            podArray.forEach(pod => {
                if (pod && pod.includes('-')) {
                    const parts = pod.split('-');
                    const vertical = parts.slice(0, -1).join('-');
                    if (vertical) allVerticals.add(vertical);
                }
            });
            
            // Also add explicitly set vertical if it exists
            if (normalized.vertical && normalized.vertical.trim() && normalized.vertical !== 'No Vertical Identified') {
                allVerticals.add(normalized.vertical);
            }
            
            // Store all verticals
            normalized._allVerticals = Array.from(allVerticals);
            
            // Derive primary vertical from pod(s) if empty
            if (!normalized.vertical || !normalized.vertical.trim()) {
                // Use first vertical found, or primary pod's vertical
                if (allVerticals.size > 0) {
                    normalized.vertical = Array.from(allVerticals)[0];
                } else if (normalized.pod && normalized.pod.includes('-') && normalized.pod !== 'No Pod Selected') {
                    const parts = normalized.pod.split('-');
                    normalized.vertical = parts.slice(0, -1).join('-') || '';
                } else {
                    // Set to "No Vertical Identified" if no pod or pod doesn't match pattern
                    normalized.vertical = 'No Vertical Identified';
                }
            } else if (!normalized.vertical || !normalized.vertical.trim()) {
                // If vertical is explicitly empty and no pod, set to "No Vertical Identified"
                if (!normalized.pod || normalized.pod === 'No Pod Selected') {
                    normalized.vertical = 'No Vertical Identified';
                }
            }
            
            // Ensure status default
            if (!normalized.status) normalized.status = 'active';
            return normalized;
        });
    }

    applyPodManagers() {
        if (!this.podManagers || Object.keys(this.podManagers).length === 0) return;
        for (const repo of this.allRepos) {
            // Collect all engineering managers from all pods
            const allManagers = new Set();
            
            // Check all pods in _allPods array
            if (repo._allPods && Array.isArray(repo._allPods)) {
                repo._allPods.forEach(pod => {
                    if (pod && this.podManagers[pod]) {
                        allManagers.add(this.podManagers[pod]);
                    }
                });
            }
            // Also check primary pod
            if (repo.pod && this.podManagers[repo.pod]) {
                allManagers.add(this.podManagers[repo.pod]);
            }
            // Also add existing engineering manager if set
            if (repo.engineeringManager && repo.engineeringManager.trim()) {
                allManagers.add(repo.engineeringManager.trim());
            }
            
            // Store all managers
            repo._allManagers = Array.from(allManagers);
            
            // Set primary manager (first one, or keep existing if set)
            if (!repo.engineeringManager || !repo.engineeringManager.trim()) {
                if (allManagers.size > 0) {
                    repo.engineeringManager = Array.from(allManagers)[0];
                }
            }
        }
    }

    async loadData() {
        // Check cache first
        const cached = this.getCachedData();
        if (cached) {
            // Re-normalize cached data to ensure _allPods is set
            this.allRepos = this.normalizeRepositories(cached);
            this.applyPodManagers();
            this.onDataLoaded();
            // Still fetch in background for freshness
            this.fetchDataInBackground();
            return;
        }

        await this.fetchData();
    }

    async fetchData() {
        try {
            // Use cache-first strategy for faster loads
            const cached = this.getCachedData();
            if (cached && cached.length > 0) {
                // Show cached data immediately (re-normalize to ensure _allPods is set)
                this.allRepos = this.normalizeRepositories(cached);
                this.applyPodManagers();
                this.onDataLoaded();
                this.render();
            }
            
            // Fetch fresh data
            const response = await fetch('data/repositories.json', {
                headers: { 'Cache-Control': 'max-age=300' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            
            // Quick validation (skip detailed checks for speed)
            const validation = this.validateData(data, true);
            if (!validation.valid) {
                console.error('Data validation failed:', validation.errors);
                this.showError('Data validation failed: ' + validation.errors.join('. '));
                return;
            }

            // Set data and render fast (normalize first - filters out archived)
            this.allRepos = this.normalizeRepositories(data.repositories || []);
            this.applyPodManagers();
                this.onDataLoaded();
            
            // Enrich in background then update cache and rerender
            const defer = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 0));
            defer(async () => {
            await this.enrichRepositoriesAsync(this.allRepos);
                this.applyPodManagers();
            this.setCachedData(this.allRepos);
                if (data.metadata) this.updateMetadataDisplay(data.metadata);
                this.applyFilters();
                this.render();
            });
            
        } catch (error) {
            console.error('Error loading data:', error);
            console.error('Error details:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
            const cached = this.getCachedData();
            if (cached && cached.length > 0) {
                console.log('Using cached data as fallback');
                // Normalize cached data
                this.allRepos = this.normalizeRepositories(cached);
                this.applyPodManagers();
                this.onDataLoaded();
                this.render();
            } else {
                const errorMsg = error.message || 'Unknown error';
                this.showError(`Error loading data: ${errorMsg}. Please check the browser console for details.`);
                console.error('Full error object:', error);
            }
        }
    }

    async enrichRepositoriesAsync(repos) {
        // For small datasets, process all at once
        // For larger datasets, chunk processing
        if (repos.length < 100) {
            // Small dataset - process synchronously
            this.allRepos = this.enrichRepositories(repos);
            return;
        }
        
        // Large dataset - process in chunks
        const chunkSize = 50;
        const enriched = [];
        
        for (let i = 0; i < repos.length; i += chunkSize) {
            const chunk = repos.slice(i, i + chunkSize);
            enriched.push(...this.enrichRepositories(chunk));
            
            // Yield to browser between chunks for large datasets
            if (i + chunkSize < repos.length && repos.length > 200) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        
        this.allRepos = enriched;
    }

    async fetchDataInBackground() {
        try {
            // Remove cache-buster to allow browser caching
            const response = await fetch('data/repositories.json', {
                headers: { 'Cache-Control': 'max-age=300' }
            });
            if (!response.ok) return;
            const data = await response.json();
            // Quick validation for background fetch
            const validation = this.validateData(data, true);
            if (validation.valid) {
                // Normalize before enriching
                const normalized = this.normalizeRepositories(data.repositories || []);
                this.allRepos = this.enrichRepositories(normalized);
                this.applyPodManagers();
                this.setCachedData(this.allRepos);
                if (data.metadata) {
                    this.updateMetadataDisplay(data.metadata);
                }
                this.applyFilters();
                this.render();
            }
        } catch (error) {
            // Silently fail in background
        }
    }

    enrichRepositories(repos) {
        return repos.map(repo => ({
            ...repo,
            githubUrl: repo.githubUrl || `https://github.com/${repo.organization}/${repo.repository}`,
            status: repo.status || 'active',
            lastActivity: repo.lastActivity || null,
            description: repo.description || '',
            language: repo.language || '',
            // Preserve _allPods and _allVerticals for display
            _allPods: repo._allPods || [],
            _allVerticals: repo._allVerticals || [],
            // GitHub API data (will be populated if enabled)
            stars: repo.stars || null,
            forks: repo.forks || null,
            issues: repo.issues || null
        }));
    }

    // Optional: Fetch additional data from GitHub API
    async enrichWithGitHubAPI(repo) {
        // Check if GitHub API is enabled (set via config or environment)
        const githubToken = localStorage.getItem('github_token') || '';
        if (!githubToken) return repo; // Skip if no token configured

        try {
            const url = `https://api.github.com/repos/${repo.organization}/${repo.repository}`;
            const headers = githubToken ? {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            } : {};

            const response = await fetch(url, { headers });
            if (response.ok) {
                const data = await response.json();
                return {
                    ...repo,
                    stars: data.stargazers_count,
                    forks: data.forks_count,
                    issues: data.open_issues_count,
                    description: repo.description || data.description || '',
                    language: repo.language || data.language || '',
                    lastActivity: repo.lastActivity || data.updated_at ? data.updated_at.split('T')[0] : null,
                    archived: data.archived || false,
                    status: data.archived ? 'archived' : (repo.status || 'active')
                };
            }
        } catch (error) {
            console.warn(`Failed to fetch GitHub data for ${repo.organization}/${repo.repository}:`, error);
        }
        return repo;
    }

    validateData(data, skipDetailed = false) {
        const errors = [];
        const warnings = [];
        
        if (!data || typeof data !== 'object') {
            errors.push('Data is not a valid object');
            return { valid: false, errors, warnings };
        }
        
        if (!data.repositories || !Array.isArray(data.repositories)) {
            errors.push('repositories must be an array');
            return { valid: false, errors, warnings };
        }

        if (data.repositories.length === 0) {
            warnings.push('No repositories found in data file');
            return { valid: true, errors, warnings }; // Empty is valid
        }

        // Skip detailed validation for cached/pre-validated data to speed up loading
        if (skipDetailed) {
            return { valid: true, errors, warnings };
        }

        // Quick validation - only check first few repos for critical fields
        // This is much faster than checking all repos
        const sampleSize = Math.min(10, data.repositories.length);
        const criticalFields = ['organization', 'repository'];
        
        for (let i = 0; i < sampleSize; i++) {
            const repo = data.repositories[i];
            for (const field of criticalFields) {
                if (!repo[field]) {
                    errors.push(`Repository ${i + 1} missing critical field: ${field}`);
                    break; // One error per repo is enough
                }
            }
        }

        // Only fail validation if there are critical errors
        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }

    getCachedData() {
        const cached = localStorage.getItem(this.cacheKey);
        const timestamp = localStorage.getItem(this.cacheTimestampKey);
        
        if (!cached || !timestamp) return null;
        
        const age = Date.now() - parseInt(timestamp);
        if (age > this.cacheMaxAge) return null;
        
        try {
            return JSON.parse(cached);
        } catch {
            return null;
        }
    }

    setCachedData(data) {
        localStorage.setItem(this.cacheKey, JSON.stringify(data));
        localStorage.setItem(this.cacheTimestampKey, Date.now().toString());
    }

    onDataLoaded() {
        // Fast path: render immediately with filters
        // Ensure a stable initial sort so layout is consistent
        if (!this.currentSort.column) {
            this.currentSort = { column: 'organization', direction: 'asc' };
        }
        this.applyFilters();
        this.render();

        // Defer heavier work to the next frame/background
        const defer = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 0));
        defer(() => {
        this.updateStats();
        this.populateFilterOptions();
            this.updateFilterChips();
            this.updateAdvancedFiltersCount();
        });
    }

    updateStats() {
        // Use single pass for better performance
        const orgs = new Set();
        const pods = new Set();
        const verticals = new Set();
        const managers = new Set();

        for (const repo of this.allRepos) {
            orgs.add(repo.organization);
            
            // Count ALL pods from _allPods array, not just primary pod
            if (repo._allPods && Array.isArray(repo._allPods) && repo._allPods.length > 0) {
                repo._allPods.forEach(pod => {
                    if (pod && pod !== 'No Pod Selected') {
                        pods.add(pod);
                        // Extract vertical from each pod
                        if (pod.includes('-')) {
                            const parts = pod.split('-');
                            const vertical = parts.slice(0, -1).join('-');
                            if (vertical) verticals.add(vertical);
                        }
                    }
                });
            } else if (repo.pod && repo.pod !== 'No Pod Selected') {
                // Fallback: use primary pod if _allPods not available
            pods.add(repo.pod);
                if (repo.pod.includes('-')) {
                    const parts = repo.pod.split('-');
                    const vertical = parts.slice(0, -1).join('-');
                    if (vertical) verticals.add(vertical);
                }
            }
            
            // Also add the primary vertical if it exists (in case it was set manually)
            if (repo.vertical && repo.vertical.trim()) {
            verticals.add(repo.vertical);
            }
            
            managers.add(repo.engineeringManager);
        }

        // Direct DOM updates (already fast, no need for requestAnimationFrame)
        const totalRepos = this.getElement('totalRepos');
        const totalOrgs = this.getElement('totalOrgs');
        const totalPods = this.getElement('totalPods');
        const totalVerticals = this.getElement('totalVerticals');
        const totalManagers = this.getElement('totalManagers');
        
        if (totalRepos) totalRepos.textContent = this.allRepos.length;
        if (totalOrgs) totalOrgs.textContent = orgs.size;
        if (totalPods) totalPods.textContent = pods.size;
        if (totalVerticals) totalVerticals.textContent = verticals.size;
        if (totalManagers) totalManagers.textContent = managers.size;
    }

    applyFilters() {
        let filtered = [...this.allRepos];

        // Search filter
        if (this.activeFilters.search) {
            const searchTerm = this.activeFilters.search.toLowerCase();
            filtered = filtered.filter(repo => {
                return Object.values(repo).some(val => 
                    val && val.toString().toLowerCase().includes(searchTerm)
                );
            });
        }

        // Multi-select filters
        if (this.activeFilters.organizations.length > 0) {
            filtered = filtered.filter(r => this.activeFilters.organizations.includes(r.organization));
        }
        if (this.activeFilters.pods.length > 0) {
            filtered = filtered.filter(r => this.activeFilters.pods.includes(r.pod));
        }
        if (this.activeFilters.verticals.length > 0) {
            filtered = filtered.filter(r => this.activeFilters.verticals.includes(r.vertical));
        }
        if (this.activeFilters.managers.length > 0) {
            filtered = filtered.filter(r => this.activeFilters.managers.includes(r.engineeringManager));
        }
        
        // Filter for repositories without a pod (value is "No Pod Selected")
        if (this.activeFilters.noPod) {
            filtered = filtered.filter(r => !r.pod || r.pod.trim() === '' || r.pod === 'No Pod Selected');
        }

        // Time-based filters
        const now = new Date();
        if (this.activeFilters.timeFilters.recent7Days) {
            const recent = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(r => {
                if (!r.lastActivity) return false;
                const activityDate = new Date(r.lastActivity);
                return activityDate >= recent;
            });
        }
        if (this.activeFilters.timeFilters.recent14Days) {
            const recent = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(r => {
                if (!r.lastActivity) return false;
                const activityDate = new Date(r.lastActivity);
                return activityDate >= recent;
            });
        }
        if (this.activeFilters.timeFilters.activeMonth) {
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(r => {
                if (!r.lastActivity) return false;
                const activityDate = new Date(r.lastActivity);
                return activityDate >= monthAgo;
            });
        }
        if (this.activeFilters.timeFilters.active60Days) {
            const daysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(r => {
                if (!r.lastActivity) return false;
                const activityDate = new Date(r.lastActivity);
                return activityDate >= daysAgo;
            });
        }
        if (this.activeFilters.timeFilters.activeQuarter) {
            const quarterAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(r => {
                if (!r.lastActivity) return false;
                const activityDate = new Date(r.lastActivity);
                return activityDate >= quarterAgo;
            });
        }
        if (this.activeFilters.timeFilters.active180Days) {
            const daysAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(r => {
                if (!r.lastActivity) return false;
                const activityDate = new Date(r.lastActivity);
                return activityDate >= daysAgo;
            });
        }
        if (this.activeFilters.timeFilters.active365Days) {
            const daysAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(r => {
                if (!r.lastActivity) return false;
                const activityDate = new Date(r.lastActivity);
                return activityDate >= daysAgo;
            });
        }
        if (this.activeFilters.timeFilters.stale90) {
            const staleThreshold = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(r => {
                if (!r.lastActivity) return true; // Include if no date (considered stale)
                const activityDate = new Date(r.lastActivity);
                return activityDate < staleThreshold;
            });
        }

        // Health/completeness filters
        if (this.activeFilters.healthFilters.missingManager) {
            filtered = filtered.filter(r => !r.engineeringManager || !r.engineeringManager.trim());
        }
        if (this.activeFilters.healthFilters.noActivityDate) {
            filtered = filtered.filter(r => !r.lastActivity || r.lastActivity.trim() === '');
        }
        if (this.activeFilters.healthFilters.missingLanguage) {
            filtered = filtered.filter(r => !r.language || r.language.trim() === '');
        }
        if (this.activeFilters.healthFilters.multiplePods) {
            filtered = filtered.filter(r => r._allPods && Array.isArray(r._allPods) && r._allPods.length > 1);
        }

        // Security filters
        if (this.activeFilters.securityFilters.critical) {
            filtered = filtered.filter(r => {
                const vulns = r.vulnerabilities;
                if (!vulns) return false;
                const codeScanning = vulns.codeScanning || {};
                const dependabot = vulns.dependabot || {};
                return ((codeScanning.critical || 0) + (dependabot.critical || 0)) > 0;
            });
        }
        if (this.activeFilters.securityFilters.high) {
            filtered = filtered.filter(r => {
                const vulns = r.vulnerabilities;
                if (!vulns) return false;
                const codeScanning = vulns.codeScanning || {};
                const dependabot = vulns.dependabot || {};
                return ((codeScanning.high || 0) + (dependabot.high || 0)) > 0;
            });
        }
        if (this.activeFilters.securityFilters.medium) {
            filtered = filtered.filter(r => {
                const vulns = r.vulnerabilities;
                if (!vulns) return false;
                const codeScanning = vulns.codeScanning || {};
                const dependabot = vulns.dependabot || {};
                return ((codeScanning.medium || 0) + (dependabot.medium || 0)) > 0;
            });
        }
        if (this.activeFilters.securityFilters.codeql) {
            filtered = filtered.filter(r => {
                const vulns = r.vulnerabilities;
                if (!vulns || !vulns.codeScanning) return false;
                return (vulns.codeScanning.total || 0) > 0;
            });
        }
        if (this.activeFilters.securityFilters.dependabot) {
            filtered = filtered.filter(r => {
                const vulns = r.vulnerabilities;
                if (!vulns || !vulns.dependabot) return false;
                return (vulns.dependabot.total || 0) > 0;
            });
        }
        if (this.activeFilters.securityFilters.secrets) {
            filtered = filtered.filter(r => {
                const vulns = r.vulnerabilities;
                if (!vulns || !vulns.secretScanning) return false;
                return (vulns.secretScanning.total || 0) > 0;
            });
        }
        if (this.activeFilters.securityFilters.secure) {
            filtered = filtered.filter(r => {
                const vulns = r.vulnerabilities;
                if (!vulns) return true; // No vulnerabilities object means secure
                const codeScanning = vulns.codeScanning || {};
                const dependabot = vulns.dependabot || {};
                const secretScanning = vulns.secretScanning || {};
                return (codeScanning.total || 0) === 0 && 
                       (dependabot.total || 0) === 0 && 
                       (secretScanning.total || 0) === 0;
            });
        }

        // Top attributes filters
        if (this.activeFilters.topAttributes.languages.length > 0) {
            filtered = filtered.filter(r => 
                r.language && this.activeFilters.topAttributes.languages.includes(r.language)
            );
        }
        if (this.activeFilters.topAttributes.pods.length > 0) {
            filtered = filtered.filter(r => {
                const allPods = r._allPods && Array.isArray(r._allPods) ? r._allPods : (r.pod ? [r.pod] : []);
                return allPods.some(pod => this.activeFilters.topAttributes.pods.includes(pod));
            });
        }
        if (this.activeFilters.topAttributes.verticals.length > 0) {
            filtered = filtered.filter(r => {
                const allVerticals = r._allVerticals && Array.isArray(r._allVerticals) ? r._allVerticals : (r.vertical ? [r.vertical] : []);
                return allVerticals.some(vertical => this.activeFilters.topAttributes.verticals.includes(vertical));
            });
        }

        this.filteredRepos = filtered;
        
        // Apply sorting
        if (this.currentSort.column) {
            this.sort(this.currentSort.column, this.currentSort.direction, true);
        }
        
        this.updateFilterChips();
        this.updateAdvancedFiltersCount();
        this.updateURL();
    }

    sort(column, direction = null, skipRender = false) {
        if (!direction) {
            // Toggle direction
            if (this.currentSort.column === column) {
                direction = this.currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                direction = 'asc';
            }
        }

        this.currentSort = { column, direction };

        const multiplier = direction === 'asc' ? 1 : -1;
        this.filteredRepos.sort((a, b) => {
            let aVal = a[column] || '';
            let bVal = b[column] || '';
            
            // Handle dates
            if (column === 'lastActivity') {
                aVal = aVal ? new Date(aVal) : new Date(0);
                bVal = bVal ? new Date(bVal) : new Date(0);
            }
            
            // Handle vulnerability sorting (sort by total critical + high issues)
            if (column === 'vulnerabilities') {
                const aVulns = a.vulnerabilities;
                const bVulns = b.vulnerabilities;
                const aCodeScanning = aVulns?.codeScanning || {};
                const bCodeScanning = bVulns?.codeScanning || {};
                const aDependabot = aVulns?.dependabot || {};
                const bDependabot = bVulns?.dependabot || {};
                const aSecrets = aVulns?.secretScanning || {};
                const bSecrets = bVulns?.secretScanning || {};
                
                // Calculate priority score: critical (1000) + high (100) + medium (10) + low (1) + secrets (50)
                const aScore = ((aCodeScanning.critical || 0) + (aDependabot.critical || 0)) * 1000 +
                               ((aCodeScanning.high || 0) + (aDependabot.high || 0)) * 100 +
                               ((aCodeScanning.medium || 0) + (aDependabot.medium || 0)) * 10 +
                               ((aCodeScanning.low || 0) + (aDependabot.low || 0)) * 1 +
                               (aSecrets.total || 0) * 50;
                const bScore = ((bCodeScanning.critical || 0) + (bDependabot.critical || 0)) * 1000 +
                               ((bCodeScanning.high || 0) + (bDependabot.high || 0)) * 100 +
                               ((bCodeScanning.medium || 0) + (bDependabot.medium || 0)) * 10 +
                               ((bCodeScanning.low || 0) + (bDependabot.low || 0)) * 1 +
                               (bSecrets.total || 0) * 50;
                
                return (aScore - bScore) * multiplier;
            }
            
            // Handle age sorting
            if (column === 'age') {
                const aAge = this.calculateAverageAge(a) || 0;
                const bAge = this.calculateAverageAge(b) || 0;
                return (aAge - bAge) * multiplier;
            }
            
            // Handle risk score sorting
            if (column === 'riskScore') {
                const aScore = this.calculateRiskScore(a);
                const bScore = this.calculateRiskScore(b);
                return (aScore - bScore) * multiplier;
            }
            
            if (aVal < bVal) return -1 * multiplier;
            if (aVal > bVal) return 1 * multiplier;
            return 0;
        });

        if (!skipRender) {
            this.render();
        }
        this.updateURL();
    }

    render() {
        const loadingSpinner = this.getElement('loadingSpinner');
        const emptyState = this.getElement('emptyState');
        const tableContainer = this.getElement('tableContainer');
        const groupedContainer = this.getElement('groupedContainer');

        if (loadingSpinner) loadingSpinner.classList.add('d-none');

        if (this.filteredRepos.length === 0) {
            if (emptyState) emptyState.classList.remove('d-none');
            if (tableContainer) tableContainer.classList.add('d-none');
            if (groupedContainer) groupedContainer.classList.add('d-none');
            return;
        }

        if (emptyState) emptyState.classList.add('d-none');

        // Ensure viewMode is valid
        if (this.viewMode !== 'table' && this.viewMode !== 'grouped') {
            console.warn('Invalid viewMode:', this.viewMode, 'defaulting to table');
            this.viewMode = 'table';
        }

        if (this.viewMode === 'grouped') {
            this.renderGroupedView();
        } else {
            this.renderTableView();
        }
        
        this.updatePagination();
        this.updateExportButton();
    }

    renderTableView() {
        const tbody = this.getElement('repoTableBody');
        const tableContainer = this.getElement('tableContainer');
        const groupedContainer = this.getElement('groupedContainer');
        
        if (!tbody || !tableContainer) {
            console.error('Required DOM elements missing for table view');
            return;
        }
        
        tableContainer.classList.remove('d-none');
        if (groupedContainer) groupedContainer.classList.add('d-none');

        const start = (this.currentPage - 1) * this.itemsPerPage;
        const end = start + this.itemsPerPage;
        const pageRepos = this.filteredRepos.slice(start, end);

        // Build HTML directly into tbody to ensure correct table parsing
        tbody.innerHTML = pageRepos.map(repo => this.renderTableRow(repo)).join('');
        
        // Update sort indicators (defer to avoid blocking)
        requestAnimationFrame(() => {
            document.querySelectorAll('th[data-sort]').forEach(th => {
                th.classList.remove('sort-asc', 'sort-desc');
                if (th.dataset.sort === this.currentSort.column) {
                    th.classList.add(this.currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
                }
            });
        });
    }

    renderPodsCell(repo) {
        // Show all pods if multiple exist
        const podsToShow = (repo._allPods && Array.isArray(repo._allPods) && repo._allPods.length > 0) 
            ? repo._allPods 
            : (repo.pod && repo.pod !== 'No Pod Selected' ? [repo.pod] : []);
        
        if (podsToShow.length === 0) {
            return '<span class="badge bg-secondary badge-custom" style="opacity: 0.7;"><i class="cil-ban" aria-hidden="true"></i> No Pod Selected</span>';
        }
        
        // Render all pods on a single line with spacing
        return podsToShow.map(pod => 
            `<span class="badge bg-primary badge-custom"><i class="cil-layers" aria-hidden="true"></i> ${this.escapeHtml(pod)}</span>`
        ).join(' ');
    }

    renderVerticalsCell(repo) {
        // Show all verticals if multiple exist
        const verticalsToShow = (repo._allVerticals && Array.isArray(repo._allVerticals) && repo._allVerticals.length > 0)
            ? repo._allVerticals
            : (repo.vertical && repo.vertical !== 'No Vertical Identified' ? [repo.vertical] : []);
        
        if (verticalsToShow.length === 0) {
            return '<span class="badge bg-secondary badge-custom" style="opacity: 0.7;"><i class="cil-ban" aria-hidden="true"></i> No Vertical Identified</span>';
        }
        
        // Render all verticals on a single line with spacing
        return verticalsToShow.map(vertical => 
            `<span class="badge bg-success badge-custom"><i class="cil-folder" aria-hidden="true"></i> ${this.escapeHtml(vertical)}</span>`
        ).join(' ');
    }

    renderManagersCell(repo) {
        // Show all engineering managers from all pods
        const managersToShow = (repo._allManagers && Array.isArray(repo._allManagers) && repo._allManagers.length > 0)
            ? repo._allManagers
            : (repo.engineeringManager && repo.engineeringManager.trim() ? [repo.engineeringManager.trim()] : []);
        
        if (managersToShow.length === 0) {
            return '<span class="badge bg-secondary badge-custom" style="opacity: 0.7;"><i class="cil-ban" aria-hidden="true"></i> No Manager</span>';
        }
        
        // Render all managers on a single line with spacing
        return managersToShow.map(mgr => 
            `<span class="badge bg-warning badge-custom text-dark"><i class="cil-user" aria-hidden="true"></i> ${this.escapeHtml(mgr)}</span>`
        ).join(' ');
    }

    calculateRiskScore(repo) {
        const vulns = repo.vulnerabilities;
        if (!vulns) return 0;
        
        const codeScanning = vulns.codeScanning || {};
        const dependabot = vulns.dependabot || {};
        const secretScanning = vulns.secretScanning || {};
        
        // Severity weights: Critical=10, High=7, Medium=4, Low=2, Info=1
        const critical = (codeScanning?.critical || 0) + (dependabot?.critical || 0);
        const high = (codeScanning?.high || 0) + (dependabot?.high || 0);
        const medium = (codeScanning?.medium || 0) + (dependabot?.medium || 0);
        const low = (codeScanning?.low || 0) + (dependabot?.low || 0);
        const info = (codeScanning?.info || 0) + (dependabot?.info || 0);
        const secrets = secretScanning?.total || 0;
        
        // Base score from severity counts
        let baseScore = (critical * 10) + (high * 7) + (medium * 4) + (low * 2) + (info * 1) + (secrets * 5);
        
        // Age multiplier (exponential): older issues weigh more
        const sastAge = codeScanning?.aging?.averageAge || 0;
        const scaAge = dependabot?.aging?.averageAge || 0;
        const secretsAge = secretScanning?.aging?.averageAge || 0;
        const maxAge = Math.max(sastAge, scaAge, secretsAge);
        
        // Age multiplier: 1.0 for 0 days, 1.5 for 30 days, 2.0 for 90 days, 2.5 for 180+ days
        let ageMultiplier = 1.0;
        if (maxAge > 0) {
            ageMultiplier = 1.0 + (maxAge / 60); // Linear scaling, caps around 4x for very old
            ageMultiplier = Math.min(ageMultiplier, 3.0); // Cap at 3x
        }
        
        // Exposure: public repos get 1.2x multiplier (if we had this data)
        // For now, we'll skip this as we don't track visibility
        
        const finalScore = Math.round(baseScore * ageMultiplier);
        return finalScore;
    }
    
    calculateAverageAge(repo) {
        const vulns = repo.vulnerabilities;
        if (!vulns) return null;
        
        const codeScanning = vulns.codeScanning || {};
        const dependabot = vulns.dependabot || {};
        const secretScanning = vulns.secretScanning || {};
        
        const ages = [];
        if (codeScanning?.aging?.averageAge) ages.push(codeScanning.aging.averageAge);
        if (dependabot?.aging?.averageAge) ages.push(dependabot.aging.averageAge);
        if (secretScanning?.aging?.averageAge) ages.push(secretScanning.aging.averageAge);
        
        if (ages.length === 0) return null;
        return Math.round(ages.reduce((a, b) => a + b, 0) / ages.length);
    }
    
    renderAgeCell(repo) {
        const age = this.calculateAverageAge(repo);
        if (age === null) return '<span class="text-muted">—</span>';
        
        // Color code by age buckets
        let badgeClass = 'bg-success';
        let icon = 'cil-check-circle';
        if (age > 180) {
            badgeClass = 'bg-danger';
            icon = 'cil-warning';
        } else if (age > 90) {
            badgeClass = 'bg-warning';
            icon = 'cil-warning';
        } else if (age > 30) {
            badgeClass = 'bg-info';
            icon = 'cil-clock';
        }
        
        return `<span class="badge ${badgeClass} badge-custom" title="Average age of vulnerabilities"><i class="${icon}" aria-hidden="true"></i> ${age}d</span>`;
    }
    
    renderRiskScoreCell(repo) {
        const riskScore = this.calculateRiskScore(repo);
        if (riskScore === 0) return '<span class="badge bg-success badge-custom"><i class="cil-check-circle"></i> 0</span>';
        
        // Color code by risk level
        let badgeClass = 'bg-success';
        let icon = 'cil-shield-alt';
        if (riskScore >= 100) {
            badgeClass = 'bg-danger';
            icon = 'cil-warning';
        } else if (riskScore >= 50) {
            badgeClass = 'bg-warning';
            icon = 'cil-warning';
        } else if (riskScore >= 20) {
            badgeClass = 'bg-info';
            icon = 'cil-info';
        }
        
        return `<span class="badge ${badgeClass} badge-custom" title="Risk Score (severity × age)"><i class="${icon}" aria-hidden="true"></i> ${riskScore}</span>`;
    }

    renderSecurityCell(repo) {
        const vulns = repo.vulnerabilities;
        if (!vulns) {
            // No vulnerability data - show secure badge
            return `<span class="badge bg-success badge-custom" title="No security data available" data-bs-toggle="tooltip" data-bs-placement="top"><i class="cil-check-circle" aria-hidden="true"></i> Secure</span>`;
        }
        
        const codeScanning = vulns.codeScanning || {};
        const dependabot = vulns.dependabot || {};
        const secretScanning = vulns.secretScanning || {};
        
        // Calculate totals (defensive - handle undefined)
        const totalCritical = (codeScanning?.critical || 0) + (dependabot?.critical || 0);
        const totalHigh = (codeScanning?.high || 0) + (dependabot?.high || 0);
        const totalMedium = (codeScanning?.medium || 0) + (dependabot?.medium || 0);
        const totalLow = (codeScanning?.low || 0) + (dependabot?.low || 0);
        const totalSecrets = secretScanning?.total || 0;
        const totalIssues = (codeScanning?.total || 0) + (dependabot?.total || 0) + totalSecrets;
        
        // Build tooltip text with all severity levels
        let tooltipParts = [];
        if ((codeScanning?.total || 0) > 0) {
            tooltipParts.push(`SAST: ${codeScanning.total} (C:${codeScanning.critical || 0} H:${codeScanning.high || 0} M:${codeScanning.medium || 0} L:${codeScanning.low || 0} I:${codeScanning.info || 0})`);
        }
        if ((dependabot?.total || 0) > 0) {
            tooltipParts.push(`SCA: ${dependabot.total} (C:${dependabot.critical || 0} H:${dependabot.high || 0} M:${dependabot.medium || 0} L:${dependabot.low || 0} I:${dependabot.info || 0})`);
        }
        if (totalSecrets > 0) {
            tooltipParts.push(`Secrets: ${totalSecrets}`);
        }
        const tooltip = tooltipParts.length > 0 ? tooltipParts.join(' | ') : 'No security issues';
        
        // Color code by severity
        if (totalCritical > 0) {
            return `<span class="badge bg-danger badge-custom" title="${tooltip}" data-bs-toggle="tooltip" data-bs-placement="top"><i class="cil-warning" aria-hidden="true"></i> ${totalCritical} Critical</span>`;
        } else if (totalHigh > 0) {
            return `<span class="badge bg-warning badge-custom text-dark" title="${tooltip}" data-bs-toggle="tooltip" data-bs-placement="top"><i class="cil-warning" aria-hidden="true"></i> ${totalHigh} High</span>`;
        } else if (totalIssues > 0) {
            return `<span class="badge bg-info badge-custom" title="${tooltip}" data-bs-toggle="tooltip" data-bs-placement="top"><i class="cil-shield-alt" aria-hidden="true"></i> ${totalIssues}</span>`;
        } else {
            return `<span class="badge bg-success badge-custom" title="No open security issues" data-bs-toggle="tooltip" data-bs-placement="top"><i class="cil-check-circle" aria-hidden="true"></i> Secure</span>`;
        }
    }

    formatLastActivity(dateString) {
        if (!dateString) return '<span class="text-muted" style="font-style: italic;">—</span>';
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) return '<span class="text-muted" style="font-style: italic;">—</span>';
            return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch {
            return '<span class="text-muted" style="font-style: italic;">—</span>';
        }
    }

    renderTableRow(repo) {
        const languageBadge = repo.language 
            ? `<span class="badge bg-info badge-custom">${this.escapeHtml(repo.language)}</span>`
            : '';

        const description = repo.description 
            ? `<small class="text-muted d-block mt-1">${this.escapeHtml(repo.description)}</small>`
            : '';

        return `
            <tr class="repo-row" data-repo-id="${this.escapeHtml(repo.organization + '/' + repo.repository)}">
                <td class="align-middle">
                    <span class="badge badge-custom org-badge" style="background-color: #6366f1;">
                        <i class="cil-building"></i> ${this.escapeHtml(repo.organization)}
                    </span>
                </td>
                <td class="align-middle">
                    <a href="${repo.githubUrl || '#'}" target="_blank" class="repo-link" rel="noopener noreferrer">
                        <i class="cil-code"></i> <strong>${this.escapeHtml(repo.repository)}</strong>
                    </a>
                    ${description}
                </td>
                <td class="align-middle">
                    ${this.renderPodsCell(repo)}
                </td>
                <td class="align-middle">
                    ${this.renderVerticalsCell(repo)}
                </td>
                <td class="align-middle">
                    ${this.renderManagersCell(repo)}
                </td>
                <td class="align-middle">${this.formatLastActivity(repo.lastActivity)}</td>
                <td class="align-middle">${languageBadge || '<span class="text-muted">—</span>'}</td>
                <td class="align-middle">
                    ${this.renderSecurityCell(repo)}
                </td>
                <td class="align-middle">
                    ${this.renderAgeCell(repo)}
                </td>
                <td class="align-middle">
                    ${this.renderRiskScoreCell(repo)}
                </td>
            </tr>
        `;
    }

    renderGroupedView() {
        const groupedContainer = this.getElement('groupedContainer');
        const tableContainer = this.getElement('tableContainer');
        
        if (!groupedContainer) {
            console.error('Grouped container not found, falling back to table view');
            this.viewMode = 'table';
            this.renderTableView();
            return;
        }
        
        groupedContainer.classList.remove('d-none');
        if (tableContainer) tableContainer.classList.add('d-none');

        const grouped = {};
        this.filteredRepos.forEach(repo => {
            if (!grouped[repo.organization]) {
                grouped[repo.organization] = [];
            }
            grouped[repo.organization].push(repo);
        });

        const sortedOrgs = Object.keys(grouped).sort();
        
        groupedContainer.innerHTML = sortedOrgs.map(org => {
            const repos = grouped[org];
            return `
                <div class="card mb-3">
                    <div class="card-header d-flex justify-content-between align-items-center" style="cursor: pointer;" onclick="this.nextElementSibling.classList.toggle('d-none')">
                        <strong>
                            <i class="cil-building"></i> ${this.escapeHtml(org)}
                            <span class="badge bg-secondary ms-2">${repos.length}</span>
                        </strong>
                        <i class="cil-chevron-bottom"></i>
                    </div>
                    <div class="card-body">
                        <div class="table-responsive">
                            <table class="table table-sm">
                                <thead>
                                    <tr>
                                        <th>Repository</th>
                                        <th>Pod</th>
                                        <th>Vertical</th>
                                        <th>Manager</th>
                                        <th>Last Activity</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${repos.map(repo => `
                                        <tr>
                                            <td>
                                                <a href="${repo.githubUrl}" target="_blank">
                                                    ${this.escapeHtml(repo.repository)}
                                                </a>
                                                ${repo.description ? `<small class="text-muted d-block">${this.escapeHtml(repo.description)}</small>` : ''}
                                            </td>
                                            <td>${this.renderPodsCell(repo)}</td>
                                            <td>${this.renderVerticalsCell(repo)}</td>
                                            <td>${this.renderManagersCell(repo)}</td>
                                            <td>${this.formatLastActivity(repo.lastActivity)}</td>
                                            <td>${this.renderSecurityCell(repo)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    populateFilterOptions() {
        const orgs = [...new Set(this.allRepos.map(r => r.organization))].sort();
        // Filter out "No Pod Selected" from pod dropdown - it's handled by checkbox filter
        const pods = [...new Set(this.allRepos.map(r => r.pod).filter(p => p && p !== 'No Pod Selected'))].sort();
        const verticals = [...new Set(this.allRepos.map(r => r.vertical))].sort();
        const managers = [...new Set(this.allRepos.map(r => r.engineeringManager))].sort();

        // Populate filter dropdowns
        this.populateFilterDropdown('filterOrg', orgs, 'organizations');
        this.populateFilterDropdown('filterPod', pods, 'pods');
        this.populateFilterDropdown('filterVertical', verticals, 'verticals');
        this.populateFilterDropdown('filterManager', managers, 'managers');

        // Quick filter badges
        const quickFilters = document.getElementById('quickFilters');
        if (quickFilters) {
            quickFilters.innerHTML = `
                <span class="badge bg-secondary filter-badge" onclick="tracker.clearFilters()">Clear All</span>
            `;
            orgs.slice(0, 5).forEach(org => {
                const badge = document.createElement('span');
                badge.className = 'badge filter-badge';
                badge.style.backgroundColor = '#6366f1';
                badge.textContent = org;
                badge.onclick = () => this.toggleFilter('organizations', org);
                quickFilters.appendChild(badge);
            });
        }
    }

    populateFilterDropdown(id, options, filterKey) {
        const dropdown = document.getElementById(id);
        if (!dropdown) return;

        dropdown.innerHTML = '<option value="">All</option>' +
            options.map(opt => `
                <option value="${this.escapeHtml(opt)}">${this.escapeHtml(opt)}</option>
            `).join('');

        dropdown.onchange = (e) => {
            const value = e.target.value;
            if (value) {
                this.activeFilters[filterKey] = [value];
                // If pod is selected, uncheck "No Pod" filter
                if (filterKey === 'pods') {
                    this.activeFilters.noPod = false;
                    const filterNoPod = document.getElementById('filterNoPod');
                    if (filterNoPod) filterNoPod.checked = false;
                }
            } else {
                this.activeFilters[filterKey] = [];
            }
            this.applyFilters();
            this.render();
            this.updateFilterChips();
        };
    }

    updateFilterChips() {
        const container = document.getElementById('filterChips');
        if (!container) return;

        const chips = [];

        // Search filter
        if (this.activeFilters.search) {
            chips.push({
                type: 'search',
                label: 'Search',
                value: this.activeFilters.search,
                remove: () => {
                    this.activeFilters.search = '';
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) searchInput.value = '';
                    this.applyFilters();
                    this.render();
                }
            });
        }

        // No Pod filter
        if (this.activeFilters.noPod) {
            chips.push({
                type: 'noPod',
                label: 'No Pod',
                value: 'Repositories without a Pod',
                remove: () => {
                    this.activeFilters.noPod = false;
                    const filterNoPod = document.getElementById('filterNoPod');
                    if (filterNoPod) filterNoPod.checked = false;
                    this.applyFilters();
                    this.render();
                }
            });
        }

        // Organization filters
        this.activeFilters.organizations.forEach(org => {
            chips.push({
                type: 'organization',
                label: 'Organization',
                value: org,
                remove: () => {
                    const index = this.activeFilters.organizations.indexOf(org);
                    if (index > -1) {
                        this.activeFilters.organizations.splice(index, 1);
                        this.updateFilterDropdown('filterOrg', '');
                        this.applyFilters();
                        this.render();
                    }
                }
            });
        });

        // Pod filters
        this.activeFilters.pods.forEach(pod => {
            chips.push({
                type: 'pod',
                label: 'Pod',
                value: pod,
                remove: () => {
                    const index = this.activeFilters.pods.indexOf(pod);
                    if (index > -1) {
                        this.activeFilters.pods.splice(index, 1);
                        this.updateFilterDropdown('filterPod', '');
                        this.applyFilters();
                        this.render();
                    }
                }
            });
        });

        // Vertical filters
        this.activeFilters.verticals.forEach(vertical => {
            chips.push({
                type: 'vertical',
                label: 'Vertical',
                value: vertical,
                remove: () => {
                    const index = this.activeFilters.verticals.indexOf(vertical);
                    if (index > -1) {
                        this.activeFilters.verticals.splice(index, 1);
                        this.updateFilterDropdown('filterVertical', '');
                        this.applyFilters();
                        this.render();
                    }
                }
            });
        });

        // Manager filters
        this.activeFilters.managers.forEach(manager => {
            chips.push({
                type: 'manager',
                label: 'Manager',
                value: manager,
                remove: () => {
                    const index = this.activeFilters.managers.indexOf(manager);
                    if (index > -1) {
                        this.activeFilters.managers.splice(index, 1);
                        this.updateFilterDropdown('filterManager', '');
                        this.applyFilters();
                        this.render();
                    }
                }
            });
        });

        // Advanced time filters
        if (this.activeFilters.timeFilters.activeMonth) {
            chips.push({
                type: 'time',
                label: 'Time',
                value: 'Active This Month',
                remove: () => {
                    this.activeFilters.timeFilters.activeMonth = false;
                    this.updateAdvancedFiltersUI();
                    this.applyFilters();
                    this.render();
                }
            });
        }
        if (this.activeFilters.timeFilters.activeQuarter) {
            chips.push({
                type: 'time',
                label: 'Time',
                value: 'Active This Quarter',
                remove: () => {
                    this.activeFilters.timeFilters.activeQuarter = false;
                    this.updateAdvancedFiltersUI();
                    this.applyFilters();
                    this.render();
                }
            });
        }
        if (this.activeFilters.timeFilters.recent14Days) {
            chips.push({
                type: 'time',
                label: 'Time',
                value: 'Recently Updated (14 days)',
                remove: () => {
                    this.activeFilters.timeFilters.recent14Days = false;
                    this.updateAdvancedFiltersUI();
                    this.applyFilters();
                    this.render();
                }
            });
        }
        if (this.activeFilters.timeFilters.stale90) {
            chips.push({
                type: 'time',
                label: 'Time',
                value: 'Stale (90+ days)',
                remove: () => {
                    this.activeFilters.timeFilters.stale90 = false;
                    this.updateAdvancedFiltersUI();
                    this.applyFilters();
                    this.render();
                }
            });
        }

        // Advanced health filters
        if (this.activeFilters.healthFilters.missingManager) {
            chips.push({
                type: 'health',
                label: 'Health',
                value: 'Missing Manager',
                remove: () => {
                    this.activeFilters.healthFilters.missingManager = false;
                    this.updateAdvancedFiltersUI();
                    this.applyFilters();
                    this.render();
                }
            });
        }
        if (this.activeFilters.healthFilters.noActivityDate) {
            chips.push({
                type: 'health',
                label: 'Health',
                value: 'No Activity Date',
                remove: () => {
                    this.activeFilters.healthFilters.noActivityDate = false;
                    this.updateAdvancedFiltersUI();
                    this.applyFilters();
                    this.render();
                }
            });
        }
        if (this.activeFilters.healthFilters.missingLanguage) {
            chips.push({
                type: 'health',
                label: 'Health',
                value: 'Missing Language',
                remove: () => {
                    this.activeFilters.healthFilters.missingLanguage = false;
                    this.updateAdvancedFiltersUI();
                    this.applyFilters();
                    this.render();
                }
            });
        }
        if (this.activeFilters.healthFilters.multiplePods) {
            chips.push({
                type: 'health',
                label: 'Health',
                value: 'Has Multiple Pods',
                remove: () => {
                    this.activeFilters.healthFilters.multiplePods = false;
                    this.updateAdvancedFiltersUI();
                    this.applyFilters();
                    this.render();
                }
            });
        }

        // Top attributes filters
        this.activeFilters.topAttributes.languages.forEach(lang => {
            chips.push({
                type: 'topAttribute',
                label: 'Language',
                value: lang,
                remove: () => {
                    this.activeFilters.topAttributes.languages = this.activeFilters.topAttributes.languages.filter(l => l !== lang);
                    this.populateTopAttributes();
                    this.applyFilters();
                    this.render();
                }
            });
        });
        this.activeFilters.topAttributes.pods.forEach(pod => {
            chips.push({
                type: 'topAttribute',
                label: 'Pod',
                value: pod,
                remove: () => {
                    this.activeFilters.topAttributes.pods = this.activeFilters.topAttributes.pods.filter(p => p !== pod);
                    this.populateTopAttributes();
                    this.applyFilters();
                    this.render();
                }
            });
        });
        this.activeFilters.topAttributes.verticals.forEach(vertical => {
            chips.push({
                type: 'topAttribute',
                label: 'Vertical',
                value: vertical,
                remove: () => {
                    this.activeFilters.topAttributes.verticals = this.activeFilters.topAttributes.verticals.filter(v => v !== vertical);
                    this.populateTopAttributes();
                    this.applyFilters();
                    this.render();
                }
            });
        });

        if (chips.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = chips.map((chip, idx) => `
            <div class="filter-chip">
                <span class="chip-label">${this.escapeHtml(chip.label)}:</span>
                <span class="chip-value">${this.escapeHtml(chip.value)}</span>
                <span class="chip-remove" onclick="tracker.removeFilterChip('${chip.type}', ${idx})" aria-label="Remove ${this.escapeHtml(chip.label)} filter">
                    <i class="cil-x"></i>
                </span>
            </div>
        `).join('');

        // Add clear all button if there are chips
        if (chips.length > 1) {
            const clearAll = document.createElement('div');
            clearAll.className = 'filter-chip';
            clearAll.style.cursor = 'pointer';
            clearAll.innerHTML = `
                <span class="chip-label" style="color: var(--text-secondary);">Clear All</span>
                <i class="cil-x" style="font-size: 0.75rem;"></i>
            `;
            clearAll.onclick = () => this.clearFilters();
            container.appendChild(clearAll);
        }
    }

    removeFilterChip(type, index) {
        // This will be called from onclick, so we need to find the chip by type
        const typeMap = {
            'search': 'search',
            'organization': 'organizations',
            'pod': 'pods',
            'vertical': 'verticals',
            'manager': 'managers',
            'status': 'status',
            'noPod': 'noPod'
        };

        const filterKey = typeMap[type];
        if (!filterKey) return;

        if (type === 'search') {
            this.activeFilters.search = '';
            const searchInput = document.getElementById('searchInput');
            if (searchInput) searchInput.value = '';
        } else if (type === 'noPod') {
            this.activeFilters.noPod = false;
            const filterNoPod = document.getElementById('filterNoPod');
            if (filterNoPod) filterNoPod.checked = false;
        } else {
            const array = this.activeFilters[filterKey];
            if (array && array.length > index) {
                const removed = array[index];
                array.splice(index, 1);
                const dropdownId = 'filter' + type.charAt(0).toUpperCase() + type.slice(1);
                this.updateFilterDropdown(dropdownId, '');
            }
        }
        this.applyFilters();
        this.render();
    }

    updateFilterDropdown(id, value) {
        const dropdown = document.getElementById(id);
        if (dropdown) {
            dropdown.value = value;
        }
    }

    toggleFilter(filterKey, value) {
        const index = this.activeFilters[filterKey].indexOf(value);
        if (index > -1) {
            this.activeFilters[filterKey].splice(index, 1);
        } else {
            this.activeFilters[filterKey].push(value);
        }
        this.applyFilters();
        this.render();
        this.updateFilterChips();
    }

    clearFilters() {
        this.activeFilters = {
            organizations: [],
            pods: [],
            verticals: [],
            managers: [],
            search: '',
            noPod: false,
            timeFilters: {
                recent7Days: false,
                recent14Days: false,
                activeMonth: false,
                active60Days: false,
                activeQuarter: false,
                active180Days: false,
                active365Days: false,
                stale90: false
            },
            healthFilters: {
                missingManager: false,
                noActivityDate: false,
                missingLanguage: false,
                multiplePods: false
            },
            securityFilters: {
                critical: false,
                high: false,
                medium: false,
                codeql: false,
                dependabot: false,
                secrets: false,
                secure: false
            },
            topAttributes: {
                languages: [],
                pods: [],
                verticals: []
            }
        };
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = '';
        const filterNoPod = document.getElementById('filterNoPod');
        if (filterNoPod) filterNoPod.checked = false;
        
        // Reset all filter dropdowns to "All"
        this.updateFilterDropdown('filterOrg', '');
        this.updateFilterDropdown('filterPod', '');
        this.updateFilterDropdown('filterVertical', '');
        this.updateFilterDropdown('filterManager', '');
        
        // Reset advanced filters UI
        this.resetAdvancedFiltersUI();
        
        this.currentPage = 1;
        this.applyFilters();
        this.render();
        this.updateFilterChips();
        this.updateAdvancedFiltersCount();
        this.showToast('Filters cleared', 'All filters have been removed', 'info');
    }

    openAdvancedFilters() {
        this.populateTopAttributes();
        this.updateAdvancedFiltersUI();
        const modalElement = document.getElementById('advancedFiltersModal');
        if (modalElement) {
            // CoreUI uses Bootstrap modals, initialize if needed
            let modal = bootstrap.Modal.getInstance(modalElement);
            if (!modal) {
                modal = new bootstrap.Modal(modalElement);
            }
            modal.show();
        }
    }

    populateTopAttributes() {
        // Get top languages (top 5)
        const languageCounts = {};
        this.allRepos.forEach(repo => {
            if (repo.language) {
                languageCounts[repo.language] = (languageCounts[repo.language] || 0) + 1;
            }
        });
        const topLanguages = Object.entries(languageCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([lang]) => lang);

        // Get top pods (top 5)
        const podCounts = {};
        this.allRepos.forEach(repo => {
            const allPods = repo._allPods && Array.isArray(repo._allPods) ? repo._allPods : (repo.pod ? [repo.pod] : []);
            allPods.forEach(pod => {
                if (pod && pod !== 'No Pod Selected') {
                    podCounts[pod] = (podCounts[pod] || 0) + 1;
                }
            });
        });
        const topPods = Object.entries(podCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([pod]) => pod);

        // Get top verticals (top 5)
        const verticalCounts = {};
        this.allRepos.forEach(repo => {
            const allVerticals = repo._allVerticals && Array.isArray(repo._allVerticals) ? repo._allVerticals : (repo.vertical ? [repo.vertical] : []);
            allVerticals.forEach(vertical => {
                if (vertical && vertical !== 'No Vertical Identified') {
                    verticalCounts[vertical] = (verticalCounts[vertical] || 0) + 1;
                }
            });
        });
        const topVerticals = Object.entries(verticalCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([vertical]) => vertical);

        // Populate language checkboxes
        const langContainer = document.getElementById('topLanguagesFilters');
        if (langContainer) {
            langContainer.innerHTML = topLanguages.map(lang => `
                <div class="form-check">
                    <input class="form-check-input" type="checkbox" id="topLang_${this.escapeHtml(lang)}" 
                           ${this.activeFilters.topAttributes.languages.includes(lang) ? 'checked' : ''}
                           onchange="tracker.toggleTopAttribute('languages', '${this.escapeHtml(lang)}')">
                    <label class="form-check-label" for="topLang_${this.escapeHtml(lang)}">
                        ${this.escapeHtml(lang)}
                    </label>
                </div>
            `).join('');
        }

        // Populate pod checkboxes
        const podContainer = document.getElementById('topPodsFilters');
        if (podContainer) {
            podContainer.innerHTML = topPods.map(pod => `
                <div class="form-check">
                    <input class="form-check-input" type="checkbox" id="topPod_${this.escapeHtml(pod)}" 
                           ${this.activeFilters.topAttributes.pods.includes(pod) ? 'checked' : ''}
                           onchange="tracker.toggleTopAttribute('pods', '${this.escapeHtml(pod)}')">
                    <label class="form-check-label" for="topPod_${this.escapeHtml(pod)}">
                        ${this.escapeHtml(pod)}
                    </label>
                </div>
            `).join('');
        }

        // Populate vertical checkboxes
        const verticalContainer = document.getElementById('topVerticalsFilters');
        if (verticalContainer) {
            verticalContainer.innerHTML = topVerticals.map(vertical => `
                <div class="form-check">
                    <input class="form-check-input" type="checkbox" id="topVertical_${this.escapeHtml(vertical)}" 
                           ${this.activeFilters.topAttributes.verticals.includes(vertical) ? 'checked' : ''}
                           onchange="tracker.toggleTopAttribute('verticals', '${this.escapeHtml(vertical)}')">
                    <label class="form-check-label" for="topVertical_${this.escapeHtml(vertical)}">
                        ${this.escapeHtml(vertical)}
                    </label>
                </div>
            `).join('');
        }
    }

    updateAdvancedFiltersUI() {
        // Update time filter checkboxes
        const timeFilterMap = {
            'filterRecent7Days': 'recent7Days',
            'filterRecent14Days': 'recent14Days',
            'filterActiveMonth': 'activeMonth',
            'filterActive60Days': 'active60Days',
            'filterActiveQuarter': 'activeQuarter',
            'filterActive180Days': 'active180Days',
            'filterActive365Days': 'active365Days',
            'filterStale90': 'stale90'
        };
        
        Object.entries(timeFilterMap).forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.checked = this.activeFilters.timeFilters[key] || false;
        });

        // Update health filter checkboxes
        document.getElementById('filterMissingManager').checked = this.activeFilters.healthFilters.missingManager;
        document.getElementById('filterNoActivityDate').checked = this.activeFilters.healthFilters.noActivityDate;
        document.getElementById('filterMissingLanguage').checked = this.activeFilters.healthFilters.missingLanguage;
        document.getElementById('filterMultiplePods').checked = this.activeFilters.healthFilters.multiplePods;
        
        // Update security filter checkboxes
        if (document.getElementById('filterCriticalSecurity')) {
            document.getElementById('filterCriticalSecurity').checked = this.activeFilters.securityFilters.critical;
        }
        if (document.getElementById('filterHighSecurity')) {
            document.getElementById('filterHighSecurity').checked = this.activeFilters.securityFilters.high;
        }
        if (document.getElementById('filterMediumSecurity')) {
            document.getElementById('filterMediumSecurity').checked = this.activeFilters.securityFilters.medium;
        }
        if (document.getElementById('filterCodeQL')) {
            document.getElementById('filterCodeQL').checked = this.activeFilters.securityFilters.codeql;
        }
        if (document.getElementById('filterDependabot')) {
            document.getElementById('filterDependabot').checked = this.activeFilters.securityFilters.dependabot;
        }
        if (document.getElementById('filterSecrets')) {
            document.getElementById('filterSecrets').checked = this.activeFilters.securityFilters.secrets;
        }
        if (document.getElementById('filterSecure')) {
            document.getElementById('filterSecure').checked = this.activeFilters.securityFilters.secure;
        }
    }

    toggleTimeFilter(filterName) {
        this.activeFilters.timeFilters[filterName] = !this.activeFilters.timeFilters[filterName];
    }

    toggleHealthFilter(filterName) {
        this.activeFilters.healthFilters[filterName] = !this.activeFilters.healthFilters[filterName];
    }

    toggleSecurityFilter(filterName) {
        this.activeFilters.securityFilters[filterName] = !this.activeFilters.securityFilters[filterName];
    }

    toggleTopAttribute(type, value) {
        const index = this.activeFilters.topAttributes[type].indexOf(value);
        if (index > -1) {
            this.activeFilters.topAttributes[type].splice(index, 1);
        } else {
            this.activeFilters.topAttributes[type].push(value);
        }
    }

    applyAdvancedFilters() {
        this.currentPage = 1;
        this.applyFilters();
        this.render();
        this.updateFilterChips();
        this.updateAdvancedFiltersCount();
        
        // Close the modal
        const modalElement = document.getElementById('advancedFiltersModal');
        if (modalElement) {
            const modal = bootstrap.Modal.getInstance(modalElement);
            if (modal) {
                modal.hide();
            }
        }
    }

    resetAdvancedFilters() {
        this.activeFilters.timeFilters = {
            activeMonth: false,
            activeQuarter: false,
            recent14Days: false,
            stale90: false
        };
        this.activeFilters.healthFilters = {
            missingManager: false,
            noActivityDate: false,
            missingLanguage: false,
            multiplePods: false
        };
        this.activeFilters.securityFilters = {
            critical: false,
            high: false,
            medium: false,
            codeql: false,
            dependabot: false,
            secrets: false,
            secure: false
        };
        this.activeFilters.topAttributes = {
            languages: [],
            pods: [],
            verticals: []
        };
        this.updateAdvancedFiltersUI();
        this.populateTopAttributes();
    }

    resetAdvancedFiltersUI() {
        this.resetAdvancedFilters();
    }

    applyPreset(presetName) {
        this.resetAdvancedFilters();
        
        switch (presetName) {
            case 'mostActive':
                this.activeFilters.timeFilters.recent14Days = true;
                break;
            case 'needsAttention':
                this.activeFilters.healthFilters.missingManager = true;
                this.activeFilters.healthFilters.noActivityDate = true;
                this.activeFilters.timeFilters.stale90 = true;
                break;
            case 'completeData':
                // Show repos that have all data (inverse of missing filters)
                // This is tricky - we'd need to show repos with manager, activity date, and language
                // For now, we'll just set filters that show complete repos
                // Actually, let's just clear all filters and sort by most complete
                this.resetAdvancedFilters();
                break;
            case 'criticalSecurity':
                this.activeFilters.securityFilters.critical = true;
                break;
            case 'highSecurity':
                this.activeFilters.securityFilters.high = true;
                break;
            case 'exposedSecrets':
                this.activeFilters.securityFilters.secrets = true;
                break;
        }
        
        this.updateAdvancedFiltersUI();
        this.populateTopAttributes();
    }

    updateAdvancedFiltersCount() {
        let count = 0;
        
        // Count time filters
        Object.values(this.activeFilters.timeFilters).forEach(val => {
            if (val) count++;
        });
        
        // Count health filters
        Object.values(this.activeFilters.healthFilters).forEach(val => {
            if (val) count++;
        });

        // Count security filters
        Object.values(this.activeFilters.securityFilters).forEach(val => {
            if (val) count++;
        });

        // Count top attributes
        count += this.activeFilters.topAttributes.languages.length;
        count += this.activeFilters.topAttributes.pods.length;
        count += this.activeFilters.topAttributes.verticals.length;
        
        const badge = document.getElementById('advancedFiltersCount');
        if (badge) {
            if (count > 0) {
                badge.textContent = count;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }
    }

    export(format = 'csv') {
        if (this.filteredRepos.length === 0) {
            this.showToast('No data', 'No repositories to export', 'warning');
            return;
        }

        if (format === 'csv') {
            this.exportCSV();
        } else {
            this.exportJSON();
        }
    }

    exportCSV() {
        const headers = ['Organization', 'Repository', 'Pod', 'Vertical', 'Engineering Manager', 'Language', 'Description', 'Last Activity', 'Security Issues', 'SAST Total', 'SAST Critical', 'SAST High', 'SAST Medium', 'SAST Low', 'SAST Info', 'SCA Total', 'SCA Critical', 'SCA High', 'SCA Medium', 'SCA Low', 'SCA Info', 'Secrets Total', 'Avg Age (Days)', 'Risk Score', 'MTTR (Days)', 'GitHub URL'];
        const rows = [headers.join(',')];

        this.filteredRepos.forEach(repo => {
            // Collect all managers for CSV
            const allManagers = (repo._allManagers && Array.isArray(repo._allManagers) && repo._allManagers.length > 0)
                ? repo._allManagers.join(', ')
                : (repo.engineeringManager || '');
            // Collect all pods for CSV
            const allPods = (repo._allPods && Array.isArray(repo._allPods) && repo._allPods.length > 0)
                ? repo._allPods.join(', ')
                : (repo.pod || '');
            // Collect all verticals for CSV
            const allVerticals = (repo._allVerticals && Array.isArray(repo._allVerticals) && repo._allVerticals.length > 0)
                ? repo._allVerticals.join(', ')
                : (repo.vertical || '');
            
            // Calculate vulnerability totals
            const vulns = repo.vulnerabilities;
            if (!vulns) {
                // No vulnerability data - add zeros
                const row = [
                    repo.organization,
                    repo.repository,
                    allPods,
                    allVerticals,
                    allManagers,
                    repo.language || '',
                    (repo.description || '').replace(/"/g, '""'),
                    repo.lastActivity || '',
                    '0',
                    0, 0, 0, 0, 0,  // SAST columns (Total, Critical, High, Medium, Low, Info)
                    0, 0, 0, 0, 0, 0,  // SCA columns (Total, Critical, High, Medium, Low, Info)
                    0,  // Secrets Total
                    '',  // Avg Age
                    0,  // Risk Score
                    '',  // MTTR
                    repo.githubUrl
                ].map(cell => `"${cell}"`);
                rows.push(row.join(','));
                return;
            }
            
            const codeScanning = vulns.codeScanning || {};
            const dependabot = vulns.dependabot || {};
            const secretScanning = vulns.secretScanning || {};
            const totalCritical = (codeScanning.critical || 0) + (dependabot.critical || 0);
            const totalHigh = (codeScanning.high || 0) + (dependabot.high || 0);
            const totalIssues = (codeScanning.total || 0) + (dependabot.total || 0) + (secretScanning.total || 0);
            
            // Calculate age, risk score, and MTTR
            const avgAge = this.calculateAverageAge(repo);
            const riskScore = this.calculateRiskScore(repo);
            const sastMTTR = codeScanning.mttr || 0;
            const scaMTTR = dependabot.mttr || 0;
            const secretsMTTR = secretScanning.mttr || 0;
            const avgMTTR = [sastMTTR, scaMTTR, secretsMTTR].filter(m => m > 0).length > 0
                ? Math.round([sastMTTR, scaMTTR, secretsMTTR].filter(m => m > 0).reduce((a, b) => a + b, 0) / [sastMTTR, scaMTTR, secretsMTTR].filter(m => m > 0).length)
                : 0;
            
            const row = [
                repo.organization,
                repo.repository,
                allPods,
                allVerticals,
                allManagers,
                repo.language || '',
                (repo.description || '').replace(/"/g, '""'),
                repo.lastActivity || '',
                totalIssues > 0 ? `${totalCritical}C/${totalHigh}H/${totalIssues} total` : '0',
                codeScanning.total || 0,
                codeScanning.critical || 0,
                codeScanning.high || 0,
                codeScanning.medium || 0,
                codeScanning.low || 0,
                codeScanning.info || 0,
                dependabot.total || 0,
                dependabot.critical || 0,
                dependabot.high || 0,
                dependabot.medium || 0,
                dependabot.low || 0,
                dependabot.info || 0,
                secretScanning.total || 0,
                avgAge !== null ? avgAge : '',
                riskScore,
                avgMTTR,
                repo.githubUrl
            ].map(cell => `"${cell}"`);
            rows.push(row.join(','));
        });

        const csv = rows.join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `repositories_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('Export successful', `${this.filteredRepos.length} repositories exported as CSV`, 'success');
    }

    exportJSON() {
        const data = {
            exported: new Date().toISOString(),
            filters: this.activeFilters,
            count: this.filteredRepos.length,
            repositories: this.filteredRepos
        };
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `repositories_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('Export successful', `${this.filteredRepos.length} repositories exported as JSON`, 'success');
    }

    showToast(title, message, type = 'info', duration = 4000) {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const icons = {
            success: 'cil-check-circle',
            error: 'cil-warning',
            warning: 'cil-warning',
            info: 'cil-info'
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <i class="toast-icon ${icons[type] || icons.info}"></i>
            <div class="toast-content">
                <div class="toast-title">${this.escapeHtml(title)}</div>
                <div class="toast-message">${this.escapeHtml(message)}</div>
            </div>
            <span class="toast-close" onclick="this.parentElement.remove()">
                <i class="cil-x"></i>
            </span>
        `;

        container.appendChild(toast);

        // Auto-remove after duration
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.remove();
                }
            }, 300);
        }, duration);
    }

    updatePagination() {
        const pagination = document.getElementById('pagination');
        if (!pagination) return;

        const totalPages = Math.ceil(this.filteredRepos.length / this.itemsPerPage);
        
        if (totalPages <= 1) {
            pagination.innerHTML = '';
            return;
        }

        let html = `
            <div class="d-flex justify-content-between align-items-center">
                <div>
                    Showing ${(this.currentPage - 1) * this.itemsPerPage + 1} to 
                    ${Math.min(this.currentPage * this.itemsPerPage, this.filteredRepos.length)} 
                    of ${this.filteredRepos.length} repositories
                </div>
                <nav>
                    <ul class="pagination mb-0">
                        <li class="page-item ${this.currentPage === 1 ? 'disabled' : ''}">
                            <a class="page-link" href="#" onclick="tracker.goToPage(${this.currentPage - 1}); return false;">Previous</a>
                        </li>
        `;

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= this.currentPage - 2 && i <= this.currentPage + 2)) {
                html += `
                    <li class="page-item ${i === this.currentPage ? 'active' : ''}">
                        <a class="page-link" href="#" onclick="tracker.goToPage(${i}); return false;">${i}</a>
                    </li>
                `;
            } else if (i === this.currentPage - 3 || i === this.currentPage + 3) {
                html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
            }
        }

        html += `
                        <li class="page-item ${this.currentPage === totalPages ? 'disabled' : ''}">
                            <a class="page-link" href="#" onclick="tracker.goToPage(${this.currentPage + 1}); return false;">Next</a>
                        </li>
                    </ul>
                </nav>
            </div>
        `;

        pagination.innerHTML = html;
    }

    goToPage(page) {
        const totalPages = Math.ceil(this.filteredRepos.length / this.itemsPerPage);
        if (page >= 1 && page <= totalPages) {
            this.currentPage = page;
            this.render();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    updateExportButton() {
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.disabled = this.filteredRepos.length === 0;
            exportBtn.title = `Export ${this.filteredRepos.length} repositories`;
        }
    }

    updateURL() {
        const params = new URLSearchParams();
        if (this.activeFilters.search) params.set('search', this.activeFilters.search);
        if (this.activeFilters.organizations.length) params.set('orgs', this.activeFilters.organizations.join(','));
        if (this.activeFilters.pods.length) params.set('pods', this.activeFilters.pods.join(','));
        if (this.currentSort.column) {
            params.set('sort', this.currentSort.column);
            params.set('dir', this.currentSort.direction);
        }
        if (this.currentPage > 1) params.set('page', this.currentPage);
        if (this.viewMode !== 'table') params.set('view', this.viewMode);

        const newURL = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
        window.history.replaceState({}, '', newURL);
        this.updateBreadcrumbs();
    }

    loadStateFromURL() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('search')) {
            this.activeFilters.search = params.get('search');
            const searchInput = document.getElementById('searchInput');
            if (searchInput) searchInput.value = this.activeFilters.search;
        }
        if (params.get('orgs')) {
            this.activeFilters.organizations = params.get('orgs').split(',');
        }
        if (params.get('pods')) {
            this.activeFilters.pods = params.get('pods').split(',');
        }
        if (params.get('sort')) {
            this.currentSort.column = params.get('sort');
            this.currentSort.direction = params.get('dir') || 'asc';
        }
        if (params.get('page')) {
            this.currentPage = parseInt(params.get('page'));
        }
        if (params.get('view')) {
            const viewParam = params.get('view');
            // Only allow 'table' or 'grouped' view modes
            if (viewParam === 'table' || viewParam === 'grouped') {
                this.viewMode = viewParam;
            }
        }
        
        // Update breadcrumbs and filter chips after loading state
        setTimeout(() => {
            this.updateBreadcrumbs();
            this.updateFilterChips();
        }, 100);
    }

    setupEventListeners() {
        // Search with debouncing and autocomplete
        const searchInput = document.getElementById('searchInput');
        const suggestionsContainer = document.getElementById('searchSuggestions');
        let selectedSuggestionIndex = -1;
        let currentSuggestions = [];

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const value = e.target.value;
                clearTimeout(this.searchDebounceTimer);
                
                // Reset selection
                selectedSuggestionIndex = -1;
                
                // Show suggestions if there's text and container exists
                if (value.length >= 2 && suggestionsContainer) {
                    this.showSearchSuggestions(value);
                } else if (suggestionsContainer) {
                    this.hideSearchSuggestions();
                }
                
                this.searchDebounceTimer = setTimeout(() => {
                    this.activeFilters.search = value;
                    this.currentPage = 1;
                    this.applyFilters();
                    this.render();
                }, 300);
            });

            searchInput.addEventListener('focus', () => {
                if (searchInput.value.length >= 2 && suggestionsContainer) {
                    this.showSearchSuggestions(searchInput.value);
                }
            });

            searchInput.addEventListener('blur', () => {
                // Delay to allow click on suggestion
                setTimeout(() => {
                    this.hideSearchSuggestions();
                }, 200);
            });

            // Keyboard navigation for suggestions
            searchInput.addEventListener('keydown', (e) => {
                if (!suggestionsContainer || suggestionsContainer.classList.contains('d-none')) {
                    return;
                }

                const suggestions = suggestionsContainer.querySelectorAll('.suggestion-item');
                
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, suggestions.length - 1);
                    this.updateSuggestionSelection(suggestions, selectedSuggestionIndex);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
                    this.updateSuggestionSelection(suggestions, selectedSuggestionIndex);
                } else if (e.key === 'Enter' && selectedSuggestionIndex >= 0) {
                    e.preventDefault();
                    const selected = suggestions[selectedSuggestionIndex];
                    if (selected) {
                        selected.click();
                    }
                } else if (e.key === 'Escape') {
                    this.hideSearchSuggestions();
                }
            });

            // Keyboard shortcut: Ctrl/Cmd + F
            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.target.matches('input, textarea')) {
                    e.preventDefault();
                    searchInput.focus();
                }
            });
        }

        // Sort headers
        document.addEventListener('click', (e) => {
            if (e.target.closest('th[data-sort]')) {
                const th = e.target.closest('th[data-sort]');
                this.sort(th.dataset.sort);
            }
        });

        // Dark mode toggle
        const darkModeToggle = document.getElementById('darkModeToggle');
        if (darkModeToggle) {
            darkModeToggle.addEventListener('click', () => {
                this.toggleDarkMode();
            });
        }

        // View mode toggle
        const viewModeToggle = document.getElementById('viewModeToggle');
        if (viewModeToggle) {
            viewModeToggle.addEventListener('click', () => {
                this.viewMode = this.viewMode === 'table' ? 'grouped' : 'table';
                this.render();
            });
        }

        // No Pod checkbox filter
        const filterNoPod = document.getElementById('filterNoPod');
        if (filterNoPod) {
            filterNoPod.addEventListener('change', (e) => {
                this.activeFilters.noPod = e.target.checked;
                // If "No Pod" is checked, clear pod dropdown selection
                if (e.target.checked) {
                    this.activeFilters.pods = [];
                    const filterPod = document.getElementById('filterPod');
                    if (filterPod) filterPod.value = '';
                }
                this.currentPage = 1;
                this.applyFilters();
                this.updateURL();
                this.render();
                this.updateFilterChips();
            });
        }
    }

    toggleDarkMode() {
        this.darkMode = !this.darkMode;
        localStorage.setItem('darkMode', this.darkMode.toString());
        this.applyTheme();
    }

    applyTheme() {
        if (this.darkMode) {
            document.body.classList.add('dark-mode');
            const toggle = document.getElementById('darkModeToggle');
            if (toggle) toggle.innerHTML = '<i class="cil-sun"></i>';
        } else {
            document.body.classList.remove('dark-mode');
            const toggle = document.getElementById('darkModeToggle');
            if (toggle) toggle.innerHTML = '<i class="cil-moon"></i>';
        }
    }

    updateMetadataDisplay(metadata) {
        const metadataEl = document.getElementById('dataMetadata');
        if (metadataEl && metadata.lastUpdated) {
            const date = new Date(metadata.lastUpdated);
            metadataEl.innerHTML = `
                <small class="text-muted">
                    <i class="cil-info"></i> Last updated: ${this.formatDate(date.toISOString())} 
                    ${metadata.version ? `| Version: ${metadata.version}` : ''}
                </small>
            `;
        }
    }

    formatDate(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showError(message) {
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.innerHTML = `
                <div class="alert alert-danger">
                    <i class="cil-warning"></i> ${this.escapeHtml(message)}
                </div>
            `;
        }
    }

    showWarning(message) {
        // Could add a toast notification here
        console.warn(message);
    }

    showSearchSuggestions(query) {
        const suggestionsContainer = document.getElementById('searchSuggestions');
        if (!suggestionsContainer || this.allRepos.length === 0) return;

        const queryLower = query.toLowerCase();
        const suggestions = [];
        const seen = new Set();

        // Search repositories, organizations, pods, verticals, managers
        this.allRepos.forEach(repo => {
            // Repository names
            if (repo.repository.toLowerCase().includes(queryLower) && !seen.has(`repo:${repo.repository}`)) {
                seen.add(`repo:${repo.repository}`);
                suggestions.push({
                    type: 'Repository',
                    text: repo.repository,
                    value: repo.repository,
                    icon: 'cil-code'
                });
            }

            // Organizations
            if (repo.organization.toLowerCase().includes(queryLower) && !seen.has(`org:${repo.organization}`)) {
                seen.add(`org:${repo.organization}`);
                suggestions.push({
                    type: 'Organization',
                    text: repo.organization,
                    value: repo.organization,
                    icon: 'cil-building'
                });
            }

            // Pods
            if (repo.pod.toLowerCase().includes(queryLower) && !seen.has(`pod:${repo.pod}`)) {
                seen.add(`pod:${repo.pod}`);
                suggestions.push({
                    type: 'Pod',
                    text: repo.pod,
                    value: repo.pod,
                    icon: 'cil-layers'
                });
            }

            // Verticals
            if (repo.vertical.toLowerCase().includes(queryLower) && !seen.has(`vertical:${repo.vertical}`)) {
                seen.add(`vertical:${repo.vertical}`);
                suggestions.push({
                    type: 'Vertical',
                    text: repo.vertical,
                    value: repo.vertical,
                    icon: 'cil-folder'
                });
            }

            // Managers
            if (repo.engineeringManager.toLowerCase().includes(queryLower) && !seen.has(`manager:${repo.engineeringManager}`)) {
                seen.add(`manager:${repo.engineeringManager}`);
                suggestions.push({
                    type: 'Manager',
                    text: repo.engineeringManager,
                    value: repo.engineeringManager,
                    icon: 'cil-people'
                });
            }
        });

        // Limit to 10 suggestions
        suggestions.splice(10);

        if (suggestions.length === 0) {
            this.hideSearchSuggestions();
            return;
        }

        // Highlight matching text
        const html = suggestions.map((suggestion, index) => {
            const text = suggestion.text;
            const startIndex = text.toLowerCase().indexOf(queryLower);
            let highlightedText = text;
            
            if (startIndex >= 0) {
                const before = text.substring(0, startIndex);
                const match = text.substring(startIndex, startIndex + query.length);
                const after = text.substring(startIndex + query.length);
                highlightedText = `${before}<span class="suggestion-match">${this.escapeHtml(match)}</span>${after}`;
            }

            return `
                <div class="suggestion-item" data-index="${index}" data-value="${this.escapeHtml(suggestion.value)}" data-type="${suggestion.type}">
                    <div class="suggestion-type"><i class="${suggestion.icon}"></i> ${suggestion.type}</div>
                    <div class="suggestion-text">${highlightedText}</div>
                </div>
            `;
        }).join('');

        suggestionsContainer.innerHTML = html;
        suggestionsContainer.classList.remove('d-none');

        // Add click handlers
        suggestionsContainer.querySelectorAll('.suggestion-item').forEach((item, index) => {
            item.addEventListener('click', () => {
                const value = item.dataset.value;
                const searchInput = document.getElementById('searchInput');
                if (searchInput) {
                    searchInput.value = value;
                    this.activeFilters.search = value;
                    this.currentPage = 1;
                    this.applyFilters();
                    this.render();
                    this.hideSearchSuggestions();
                }
            });
        });
    }

    hideSearchSuggestions() {
        const suggestionsContainer = document.getElementById('searchSuggestions');
        if (suggestionsContainer) {
            suggestionsContainer.classList.add('d-none');
        }
    }

    updateSuggestionSelection(suggestions, index) {
        suggestions.forEach((s, i) => {
            s.classList.toggle('active', i === index);
        });
    }

    updateBreadcrumbs() {
        const breadcrumbNav = document.getElementById('breadcrumbNav');
        if (!breadcrumbNav) return;

        const breadcrumb = breadcrumbNav.querySelector('.breadcrumb');
        const params = new URLSearchParams(window.location.search);
        const items = [];

        // Home
        items.push('<li class="breadcrumb-item"><a href="index.html"><i class="cil-home"></i> Home</a></li>');

        // Check for filters
        const orgs = params.get('orgs');
        const pods = params.get('pods');
        const search = params.get('search');

        if (orgs) {
            items.push(`<li class="breadcrumb-item"><a href="index.html?orgs=${encodeURIComponent(orgs)}">Organization: ${this.escapeHtml(orgs)}</a></li>`);
        }

        if (pods) {
            items.push(`<li class="breadcrumb-item"><a href="index.html?pods=${encodeURIComponent(pods)}">Pod: ${this.escapeHtml(pods)}</a></li>`);
        }

        if (search) {
            items.push(`<li class="breadcrumb-item active">Search: "${this.escapeHtml(search)}"</li>`);
        }

        if (items.length === 1) {
            // Only home, hide breadcrumbs
            breadcrumbNav.classList.add('d-none');
        } else {
            breadcrumbNav.classList.remove('d-none');
            breadcrumb.innerHTML = items.join('');
        }
    }
}

// Initialize tracker when DOM is ready
let tracker;

// Use more efficient initialization
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTracker);
} else {
    // DOM already loaded, initialize immediately
    initTracker();
}

function initTracker() {
    // Initialize immediately for faster perceived load
    tracker = new RepositoryTracker();
}

