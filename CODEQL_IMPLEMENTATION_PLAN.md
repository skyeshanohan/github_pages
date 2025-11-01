# CODEQL Vulnerability Integration Plan

## Overview
Add CODEQL vulnerability tracking to the repository tracker, including:
- **CODEQL/SAST** (Static Application Security Testing)
- **Dependabot/SCA** (Software Composition Analysis - dependency vulnerabilities)
- **Secret Scanning** (Exposed secrets detection)

---

## 1. Data Fetching Strategy

### GitHub API Endpoints

#### 1.1 CODEQL Alerts (SAST)
```
GET /repos/{owner}/{repo}/code-scanning/alerts
```
**Query Parameters:**
- `state`: `open`, `closed`, `dismissed` (default: `open`)
- `severity`: `critical`, `high`, `medium`, `low`, `warning`, `note`
- `tool_name`: `codeql`, or specific tool name

**Response Fields:**
- `number`: Alert ID
- `state`: `open`, `closed`, `dismissed`
- `severity`: Severity level
- `rule`: Rule details (ID, description, security severity)
- `tool`: Tool that found it (e.g., "CodeQL")
- `created_at`: When alert was created
- `updated_at`: Last update time
- `url`: GitHub URL to the alert

**Rate Limits:**
- Per-repo endpoint: Subject to standard rate limits
- Pagination: Supports `per_page` (max 100), use `page` parameter

#### 1.2 Dependabot Alerts (SCA)
```
GET /repos/{owner}/{repo}/dependabot/alerts
```
**Query Parameters:**
- `state`: `open`, `dismissed`, `fixed` (default: `open`)
- `severity`: `low`, `medium`, `high`, `critical`
- `ecosystem`: `npm`, `maven`, `nuget`, `pip`, `composer`, `rubygems`, `go`, `rust`, `erlang`, `actions`, `docker`, `terraform`, `pub`, `swift`

**Response Fields:**
- `number`: Alert ID
- `state`: `open`, `dismissed`, `fixed`
- `dependency`: Affected package details
- `security_advisory`: CVE details, severity, CVSS score
- `security_vulnerability`: Affected version range
- `created_at`, `updated_at`
- `dismissed_at`: If dismissed
- `url`: GitHub URL to the alert

**Rate Limits:**
- Per-repo endpoint
- Pagination supported

#### 1.3 Secret Scanning Alerts
```
GET /repos/{owner}/{repo}/secret-scanning/alerts
```
**Query Parameters:**
- `state`: `open`, `resolved` (default: `open`)
- `secret_type`: Specific secret type (e.g., "GitHub Personal Access Token")
- `resolution`: `false_positive`, `revoked`, `used_in_tests`, `wont_fix`

**Response Fields:**
- `number`: Alert ID
- `state`: `open`, `resolved`
- `secret_type`: Type of secret detected
- `created_at`, `updated_at`, `resolved_at`
- `resolution`: How it was resolved (if resolved)
- `url`: GitHub URL to the alert

**Rate Limits:**
- Per-repo endpoint
- Pagination supported
- **Note:** Requires `secret_scanning_alerts` permission in GitHub App

---

## 2. Implementation in Sync Script

### 2.1 Add Functions to Fetch Alerts

**Location:** `scripts/sync-github-data.js`

#### Function: `fetchCodeScanningAlerts(owner, repo, token)`
```javascript
async function fetchCodeScanningAlerts(owner, repo, token) {
    try {
        const alerts = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const response = await githubRequest(
                'GET',
                `/repos/${owner}/${repo}/code-scanning/alerts?state=open&per_page=100&page=${page}`,
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
        }

        // Aggregate by severity
        const summary = {
            total: alerts.length,
            critical: alerts.filter(a => a.rule?.security_severity_level === 'critical').length,
            high: alerts.filter(a => a.rule?.security_severity_level === 'high').length,
            medium: alerts.filter(a => a.rule?.security_severity_level === 'medium').length,
            low: alerts.filter(a => a.rule?.security_severity_level === 'low').length,
            lastUpdated: alerts.length > 0 ? alerts[0].updated_at : null
        };

        return summary;
    } catch (error) {
        // Handle 403 (not enabled) or 404 (not found) gracefully
        if (error.statusCode === 403 || error.statusCode === 404) {
            return { total: 0, critical: 0, high: 0, medium: 0, low: 0, lastUpdated: null, enabled: false };
        }
        throw error;
    }
}
```

#### Function: `fetchDependabotAlerts(owner, repo, token)`
```javascript
async function fetchDependabotAlerts(owner, repo, token) {
    try {
        const alerts = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const response = await githubRequest(
                'GET',
                `/repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=100&page=${page}`,
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
        }

        // Aggregate by severity
        const summary = {
            total: alerts.length,
            critical: alerts.filter(a => a.security_advisory?.severity === 'critical').length,
            high: alerts.filter(a => a.security_advisory?.severity === 'high').length,
            medium: alerts.filter(a => a.security_advisory?.severity === 'medium').length,
            low: alerts.filter(a => a.security_advisory?.severity === 'low').length,
            ecosystems: [...new Set(alerts.map(a => a.dependency?.package?.ecosystem).filter(Boolean))],
            lastUpdated: alerts.length > 0 ? alerts[0].updated_at : null
        };

        return summary;
    } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 404) {
            return { total: 0, critical: 0, high: 0, medium: 0, low: 0, ecosystems: [], lastUpdated: null, enabled: false };
        }
        throw error;
    }
}
```

#### Function: `fetchSecretScanningAlerts(owner, repo, token)`
```javascript
async function fetchSecretScanningAlerts(owner, repo, token) {
    try {
        const alerts = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const response = await githubRequest(
                'GET',
                `/repos/${owner}/${repo}/secret-scanning/alerts?state=open&per_page=100&page=${page}`,
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
        }

        // Aggregate by secret type
        const secretTypes = {};
        alerts.forEach(alert => {
            const type = alert.secret_type || 'unknown';
            secretTypes[type] = (secretTypes[type] || 0) + 1;
        });

        return {
            total: alerts.length,
            secretTypes: secretTypes,
            lastUpdated: alerts.length > 0 ? alerts[0].updated_at : null
        };
    } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 404) {
            return { total: 0, secretTypes: {}, lastUpdated: null, enabled: false };
        }
        throw error;
    }
}
```

### 2.2 Update `enrichRepository()` Function

Add vulnerability fetching after CODEOWNERS check:

```javascript
// After CODEOWNERS check, before returning
const codeScanning = await fetchCodeScanningAlerts(repo.owner.login, repo.name, token);
const dependabot = await fetchDependabotAlerts(repo.owner.login, repo.name, token);
const secretScanning = await fetchSecretScanningAlerts(repo.owner.login, repo.name, token);

return {
    // ... existing fields ...
    vulnerabilities: {
        codeScanning: codeScanning,
        dependabot: dependabot,
        secretScanning: secretScanning
    }
};
```

### 2.3 Rate Limit Considerations

- **Additional API Calls Per Repo:** 3 calls (CODEQL, Dependabot, Secret Scanning)
- **For 900 repos:** 2,700 additional calls
- **Current Rate Limit:** 15,000/hour (GitHub App)
- **Timing:** Fetch in batches, add small delay between batches
- **Caching:** Could cache vulnerability data separately with longer TTL (vulnerabilities change less frequently than repo metadata)

### 2.4 Permission Requirements

Ensure GitHub App has these permissions:
- `Contents`: Read (already have)
- `Metadata`: Read (already have)
- `Security events`: Read (for CODEQL/Dependabot/Secret Scanning)
- `Dependabot alerts`: Read (for Dependabot)
- `Secret scanning alerts`: Read (for Secret Scanning)

---

## 3. Data Structure Updates

### 3.1 Update `repositories.json` Schema

Add to each repository object:
```json
{
  "vulnerabilities": {
    "codeScanning": {
      "total": 5,
      "critical": 1,
      "high": 2,
      "medium": 2,
      "low": 0,
      "lastUpdated": "2025-10-31T10:00:00Z",
      "enabled": true
    },
    "dependabot": {
      "total": 12,
      "critical": 0,
      "high": 5,
      "medium": 7,
      "low": 0,
      "ecosystems": ["npm", "pip"],
      "lastUpdated": "2025-10-31T10:00:00Z",
      "enabled": true
    },
    "secretScanning": {
      "total": 2,
      "secretTypes": {
        "GitHub Personal Access Token": 1,
        "AWS Access Key": 1
      },
      "lastUpdated": "2025-10-31T10:00:00Z",
      "enabled": true
    }
  }
}
```

---

## 4. Frontend Changes

### 4.1 Main Table (`index.html`)

**Add Column:** "Security Status" or "Vulnerabilities"

**Display Options:**
1. **Summary Badge** (recommended for table):
   - Show total count of critical/high alerts
   - Color-coded: Red (critical), Orange (high), Yellow (medium+high), Green (none)
   - Tooltip shows breakdown

2. **Detailed View** (on hover or click):
   - Modal showing:
     - CODEQL: X critical, Y high, Z medium
     - Dependabot: X critical, Y high (across N ecosystems)
     - Secrets: X exposed secrets (by type)

**Implementation:**
```javascript
// Add to renderTableRow()
const vulnSummary = repo.vulnerabilities || {};
const totalCritical = (vulnSummary.codeScanning?.critical || 0) + 
                      (vulnSummary.dependabot?.critical || 0);
const totalHigh = (vulnSummary.codeScanning?.high || 0) + 
                  (vulnSummary.dependabot?.high || 0);

let vulnBadge = '';
if (totalCritical > 0) {
    vulnBadge = `<span class="badge bg-danger" title="Critical vulnerabilities">🔴 ${totalCritical}</span>`;
} else if (totalHigh > 0) {
    vulnBadge = `<span class="badge bg-warning" title="High vulnerabilities">🟠 ${totalHigh}</span>`;
} else {
    const totalIssues = (vulnSummary.codeScanning?.total || 0) + 
                        (vulnSummary.dependabot?.total || 0) +
                        (vulnSummary.secretScanning?.total || 0);
    if (totalIssues > 0) {
        vulnBadge = `<span class="badge bg-info" title="${totalIssues} security issues">⚠️ ${totalIssues}</span>`;
    } else {
        vulnBadge = `<span class="badge bg-success" title="No open security issues">✓</span>`;
    }
}
```

### 4.2 Statistics Page (`stats.html`)

**Add New Cards:**
1. **Total Security Issues**: Sum of all alerts
2. **Critical Vulnerabilities**: Count of repos with critical issues
3. **Dependabot Alerts**: Total dependency vulnerabilities
4. **Exposed Secrets**: Count of repos with secret scanning alerts
5. **Repos with No Issues**: Count of clean repos

**Add Charts:**
- Pie chart: Distribution of severity levels
- Bar chart: Top repositories by vulnerability count
- Stacked bar: CODEQL vs Dependabot vs Secrets

### 4.3 Health Dashboard (`health.html`)

**Add New Section:** "Security Compliance"

**Cards:**
1. **Repos with Critical Issues**: List repos with critical vulnerabilities
2. **Repos with High Issues**: List repos with high-severity issues
3. **Repos with Exposed Secrets**: List repos with secret scanning alerts
4. **Repos without Security Enabled**: List repos where CODEQL/Dependabot not enabled
5. **Security Score**: Overall health score including vulnerability metrics

### 4.4 Vertical Pages (`vertical.html`)

**Add to Summary Statistics:**
- Total security issues for this vertical
- Breakdown by severity

**Add to Table:**
- Vulnerability column (same as main table)

### 4.5 Advanced Filters (`index.html`)

**Add Filter Options:**
1. **By Severity:**
   - Has critical vulnerabilities
   - Has high vulnerabilities
   - Has medium vulnerabilities

2. **By Type:**
   - Has CODEQL alerts
   - Has Dependabot alerts
   - Has exposed secrets

3. **Quick Presets:**
   - "Critical security issues"
   - "High priority vulnerabilities"
   - "Repos with exposed secrets"
   - "Secure repos (no issues)"

---

## 5. Export Updates

### 5.1 CSV Export
Add columns:
- `CodeScanning_Total`, `CodeScanning_Critical`, `CodeScanning_High`, `CodeScanning_Medium`
- `Dependabot_Total`, `Dependabot_Critical`, `Dependabot_High`, `Dependabot_Ecosystems`
- `SecretScanning_Total`, `SecretScanning_Types`

### 5.2 JSON Export
Include full `vulnerabilities` object in exports.

---

## 6. Performance Considerations

### 6.1 Incremental Updates
- **Option A:** Always fetch (simple, but slower)
- **Option B:** Cache vulnerability data separately with longer TTL (e.g., 24 hours)
- **Option C:** Fetch vulnerabilities on-demand via separate API endpoint

### 6.2 Background Fetching
- Fetch vulnerabilities in background after initial page load
- Show loading indicator for vulnerability column
- Update table cells as data arrives

### 6.3 Pagination
- Only show vulnerability summary in main table
- Full details in modal/detail view on click

---

## 7. UI/UX Enhancements

### 7.1 Colorblind-Friendly Design
- Use icons + text, not just colors
- Patterns/borders in addition to colors
- Clear labels

### 7.2 Tooltips and Details
- Hover over badge shows breakdown
- Click opens detailed modal
- Link to GitHub security tab

### 7.3 Sorting and Filtering
- Sort by vulnerability count
- Filter by severity/type
- Search by vulnerability details

---

## 8. Implementation Priority

**Phase 1: Core Functionality**
1. Add API fetching functions to sync script
2. Update data structure
3. Add basic display in main table
4. Update stats page

**Phase 2: Enhanced Features**
1. Health dashboard integration
2. Advanced filters
3. Detailed modals
4. Export updates

**Phase 3: Polish**
1. Performance optimizations
2. Caching strategy
3. UI refinements
4. Accessibility improvements

---

## 9. Testing Considerations

1. **Repos with alerts enabled/disabled**: Handle 403/404 gracefully
2. **Large numbers of alerts**: Test pagination
3. **Rate limiting**: Ensure script doesn't exceed limits
4. **Edge cases**: Repos with no vulnerabilities, all severities, etc.
5. **Permissions**: Verify GitHub App has required permissions

---

## 10. Documentation Updates

1. Update `README.md` with vulnerability tracking info
2. Add GitHub App permission requirements
3. Document new filter options
4. Update API documentation if exposing endpoints

