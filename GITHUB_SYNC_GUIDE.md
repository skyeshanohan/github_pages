# GitHub API Sync Guide for Large Organizations

## Problem: Syncing 900+ Repositories Efficiently

When dealing with large organizations (900+ repositories), you need a strategy that:
- ✅ Stays within GitHub API rate limits
- ✅ Minimizes unnecessary API calls
- ✅ Handles failures gracefully
- ✅ Preserves existing ownership data

## Solution Overview

### 1. GitHub App Authentication (Recommended)

**Why GitHub App?**
- **Higher rate limits**: 15,000 requests/hour per installation (vs 5,000/hour for PAT)
- **Organization-scoped**: Works across all org repositories
- **Better security**: Scoped permissions, can be revoked easily
- **Multiple installations**: Can install same app in multiple orgs

**Rate Limits:**
- Unauthenticated: 60 requests/hour ❌
- Personal Access Token: 5,000 requests/hour ⚠️
- GitHub App: 15,000 requests/hour ✅ (per installation)

### 2. Incremental Sync Strategy

Instead of fetching all 900 repos every time:

```
First Sync:   900 repos × 1 request = 900 requests ✅ (well within 15k limit)
Daily Sync:   Only changed repos (typically 5-20) ✅ (minimal usage)
```

**How it works:**
1. Fetch repository list (paginated, ~9 requests for 900 repos)
2. Compare `updated_at` timestamp with last sync
3. **Skip unchanged repos** (no API call needed)
4. Only fetch full details for changed repos

### 3. Conditional Requests (ETags)

Use HTTP ETags to avoid unnecessary data transfer:

```javascript
// First request
GET /repos/org/repo
Response: 200 OK, ETag: "abc123"

// Subsequent request (if unchanged)
GET /repos/org/repo
Headers: If-None-Match: "abc123"
Response: 304 Not Modified (saves bandwidth and counts)
```

**Benefits:**
- 304 responses don't count against rate limit
- Saves bandwidth
- Faster sync times

## Implementation Architecture

### Components Created

1. **`scripts/sync-github-data.js`**
   - Main sync script
   - Handles authentication, rate limiting, incremental updates
   - Merges GitHub data with existing ownership data

2. **`.github/workflows/sync-github-data.yml`**
   - Scheduled GitHub Actions workflow
   - Runs daily at 2 AM UTC
   - Commits and deploys automatically

3. **Cache System**
   - Stores ETags and last-modified timestamps
   - Enables incremental updates
   - File: `data/.github-cache.json` (gitignored)

### Request Flow

```
┌─────────────────┐
│ GitHub Actions  │
│   (Schedule)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Authenticate    │
│ (GitHub App)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Fetch Repo List │
│ (Paginated)    │  ~9 requests for 900 repos
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check Cache     │
│ Compare Dates   │  Skip unchanged repos
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Fetch Details   │
│ (Changed Only)  │  Typically 5-20 requests/day
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Merge Data      │
│ Preserve Owner  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Save & Commit   │
│ Deploy          │
└─────────────────┘
```

## Rate Limit Management

### Conservative Limits (Built-in)

```javascript
{
  requestsPerHour: 12000,      // Leave 3000 buffer
  requestsPerMinute: 200,       // Burst protection
  minDelayBetweenRequests: 200  // ms (5 req/sec)
}
```

### Automatic Handling

- **Detection**: Monitors `X-RateLimit-Remaining` header
- **Backoff**: Waits for reset time when limit reached
- **Retry**: Exponential backoff on failures
- **Progress**: Shows remaining requests

### Example Timeline (900 Repos)

```
First Sync:
├─ Authenticate: 1 request
├─ List repos (9 pages): 9 requests
├─ Fetch details: 900 requests
└─ Total: ~910 requests ✅ (15,000 available)

Daily Sync:
├─ Authenticate: 1 request
├─ List repos: 9 requests
├─ Changed repos: ~10 requests
└─ Total: ~20 requests ✅ (minimal usage)
```

## Data Preservation

### What Gets Updated (from GitHub)
- ✅ `description`
- ✅ `language`
- ✅ `status` (active/archived)
- ✅ `lastActivity`
- ✅ `githubUrl`

### What Gets Preserved (manual data)
- ✅ `pod`
- ✅ `vertical`
- ✅ `engineeringManager`
- ✅ Any custom fields

### Merge Logic

```javascript
existingRepo = {
  organization: "engineering",
  repository: "api-service",
  pod: "Backend",              // ← Preserved
  vertical: "Core Services",   // ← Preserved
  engineeringManager: "John",  // ← Preserved
  description: "Old desc"      // ← Updated if GitHub has better
}

githubData = {
  description: "New description",  // ← Takes precedence
  language: "TypeScript",          // ← Fills in if missing
  lastActivity: "2024-01-15"      // ← Updated
}

result = merge(existingRepo, githubData)
// Ownership data preserved, metadata updated
```

## Setup Instructions

### 1. Create GitHub App

See `scripts/README.md` for detailed steps. Quick version:

1. Organization Settings → Developer Settings → GitHub Apps
2. New GitHub App
3. Permissions: Repository metadata (Read-only)
4. Note App ID, download private key

### 2. Install App

- Install in your organization
- Select repositories (or all)

### 3. Configure Secrets

In repository Settings → Secrets:
- `APP_ID`: Your App ID
- `APP_PRIVATE_KEY`: Private key (full PEM)
- `ORG_NAME`: Organization name

**Important**: GitHub doesn't allow secret names starting with `GITHUB_` (reserved). Use the names above.

### 4. Run First Sync

Either:
- **Automatic**: Wait for scheduled run (2 AM UTC daily)
- **Manual**: Go to Actions → "Sync GitHub Repository Data" → Run workflow

## Monitoring & Debugging

### Check Sync Status

1. **GitHub Actions Tab**
   - See run history
   - View logs
   - Check for errors

2. **Sync Output**
   ```
   ✅ Sync complete! Updated 12 repositories, skipped 888 unchanged.
      Rate limit remaining: 14,980 requests
   ```

3. **Cache File** (not committed)
   - `data/.github-cache.json`
   - Shows last sync time and ETags

### Common Issues

**Issue**: "GitHub App not installed"
- **Fix**: Install app in organization settings

**Issue**: Rate limit errors
- **Fix**: Script handles automatically, but check logs if persistent

**Issue**: Missing ownership data after sync
- **Fix**: Ownership data is preserved. If missing, it wasn't in original file.

**Issue**: Too many API calls
- **Fix**: Ensure incremental sync is enabled (default)

## Advanced: Multiple Organizations

If you manage multiple organizations:

### Option 1: Multiple App Installations
Install the same GitHub App in each org:
- Same App ID, different installations
- Each gets 15,000 requests/hour
- Update workflow to loop through orgs

### Option 2: Separate Apps
Create one app per org:
- Different App IDs
- Maximum isolation
- More setup work

### Workflow Modification

```yaml
- name: Sync multiple orgs
  run: |
    for org in org1 org2 org3; do
      ORG_NAME=$org node scripts/sync-github-data.js
    done
```

## Performance Optimization

### For 900+ Repos

1. **Pagination**: Fetches 100 repos per page (~9 requests)
2. **Concurrent Requests**: 5 at a time (configurable)
3. **Incremental**: Only changed repos (~1-2% daily)
4. **Conditional Requests**: ETags prevent re-fetching

### Estimated Times

- **First sync**: 3-5 minutes
- **Daily sync**: 10-30 seconds
- **Full sync** (forced): 5-7 minutes

## Security Considerations

1. **Private Key Storage**
   - ✅ Stored as GitHub Secret (encrypted)
   - ✅ Never committed to repo
   - ✅ Can be rotated easily
   - ⚠️ **Note**: Secret names cannot start with `GITHUB_` (use `APP_ID`, `APP_PRIVATE_KEY`, `ORG_NAME` instead)

2. **App Permissions**
   - ✅ Minimum required: Read-only metadata
   - ✅ No write permissions
   - ✅ Can be revoked any time

3. **Organization Access**
   - ✅ Only repositories you install on
   - ✅ Can restrict to specific repos

## Cost Analysis

### API Request Usage

**Initial Setup:**
- 900 repos: ~910 requests (one-time)

**Daily Operations:**
- List repos: 9 requests
- Changed repos: ~10-20 requests
- **Total: ~20 requests/day**

**Monthly:**
- ~600 requests/month
- Well within 15,000/hour limit ✅

### Alternatives Considered

1. **Personal Access Token**: 
   - ❌ Only 5,000/hour (tight for 900 repos)
   - ⚠️ Less secure (can't be scoped)

2. **GitHub API GraphQL**:
   - ✅ More efficient (single query)
   - ❌ More complex to implement
   - ⚠️ Still subject to rate limits

3. **Webhook-based Updates**:
   - ✅ Real-time
   - ❌ Requires webhook infrastructure
   - ❌ Doesn't help initial sync

## Next Steps

1. ✅ Set up GitHub App
2. ✅ Configure secrets
3. ✅ Run first sync
4. ✅ Verify data updates
5. ✅ Monitor daily syncs
6. ✅ Adjust sync frequency if needed

## Questions?

- Check `scripts/README.md` for detailed setup
- Review sync script logs in GitHub Actions
- Verify rate limits in response headers

