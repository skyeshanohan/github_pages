# GitHub Data Sync Scripts

This directory contains scripts for syncing repository metadata from the GitHub API.

## Setup

### 1. Create a GitHub App

1. Go to your organization settings → Developer settings → GitHub Apps
2. Click "New GitHub App"
3. Configure:
   - **Name**: Repository Tracker Sync (or your preferred name)
   - **Homepage URL**: Your GitHub Pages URL
   - **Callback URL**: Not required
   - **Webhook**: Disable (not needed for read-only)
   - **Permissions**:
     - **Repository metadata**: Read-only
     - **Contents**: Read-only
   - **Where can this GitHub App be installed?**: Only on this account
4. After creation, note your **App ID**
5. Generate a **Private Key** (download the .pem file)

### 2. Install GitHub App in Your Organization

1. Go to your GitHub App settings → "Install App"
2. Select your organization
3. Install only on selected repositories (recommended) or all repositories
4. Grant access and install

### 3. Configure GitHub Secrets

In your repository settings → Secrets and variables → Actions, add:

- `APP_ID`: Your GitHub App ID (number)
- `APP_PRIVATE_KEY`: Your private key content (the entire PEM file, including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`)
- `ORG_NAME`: Your organization name

**Important**: GitHub doesn't allow secret names starting with `GITHUB_` (those are reserved). Use the names above instead.

**Note**: For the private key, you can either:
- Paste the entire PEM file content directly
- Or base64 encode it and set as `APP_PRIVATE_KEY_BASE64`

### 4. Install Dependencies

```bash
npm install jsonwebtoken
```

Or add to `package.json`:

```json
{
  "dependencies": {
    "jsonwebtoken": "^9.0.2"
  }
}
```

## Usage

### Automated Sync (Recommended)

The sync runs automatically via GitHub Actions:
- **Schedule**: Daily at 2 AM UTC
- **Manual trigger**: Available in Actions tab

The workflow will:
1. Fetch repository list from GitHub
2. Incrementally update only changed repositories
3. Merge with existing ownership data
4. Commit and push updates
5. Deploy to GitHub Pages

### Manual Sync (Local Development)

```bash
# Set environment variables
export APP_ID="your-app-id"
export APP_PRIVATE_KEY="your-private-key"
export ORG_NAME="your-org-name"

# Run sync
node scripts/sync-github-data.js

# Full sync (ignore cache)
node scripts/sync-github-data.js --full

# Specific organization
node scripts/sync-github-data.js --org=your-org-name
```

### Private Key Format

If your private key is base64 encoded:

```bash
export APP_PRIVATE_KEY_BASE64="base64-encoded-key"
```

Otherwise, paste the raw PEM file content:

```bash
export APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
...
-----END RSA PRIVATE KEY-----"
```

## Rate Limits

### GitHub App Authentication

- **Rate limit**: 15,000 requests/hour per organization
- **Burst limit**: Handled automatically (200 requests/minute)
- **Per-request delay**: 200ms minimum

### Strategies for 900+ Repositories

1. **Incremental Updates**: Only syncs changed repositories (uses `updated_at` timestamp)
2. **Conditional Requests**: Uses ETags to skip unchanged repos (304 Not Modified)
3. **Batch Processing**: Processes 5 repos concurrently
4. **Rate Limit Handling**: Automatic backoff when approaching limits

### First Sync

For 900 repositories:
- Initial sync: ~900 requests (one per repo)
- Estimated time: ~3-5 minutes
- Well within rate limits (15,000/hour)

### Subsequent Syncs

- Only changed repos are fetched
- Typically 5-20 repos per day
- Sync time: ~10-30 seconds

## How It Works

### Incremental Sync Process

1. **Fetch Repository List**: Gets all repos from org (paginated, ~9 requests for 900 repos)
2. **Compare Timestamps**: Checks `updated_at` vs last sync time
3. **Skip Unchanged**: Repos not updated since last sync are skipped
4. **Fetch Details**: Only fetch full details for changed repos
5. **Merge Data**: Combines GitHub metadata with existing ownership data
6. **Save**: Updates `repositories.json` and cache

### Data Preservation

- **Ownership data preserved**: pod, vertical, engineeringManager are never overwritten
- **Metadata updated**: description, language, lastActivity, status are updated from GitHub
- **New repos**: Added to file, but need manual ownership assignment

### Cache System

- Stores ETags for conditional requests
- Tracks last modified timestamps
- Cache file: `data/.github-cache.json` (gitignored)

## Troubleshooting

### "GitHub App not installed"

- Ensure the app is installed in your organization
- Check that you're using the correct organization name

### Rate Limit Errors

- Script automatically waits for rate limit reset
- Increase `minDelayBetweenRequests` in config if needed

### Authentication Errors

- Verify `APP_ID` secret is correct
- Check private key format (should include BEGIN/END markers)
- Ensure app has correct permissions
- Remember: GitHub secrets cannot start with `GITHUB_` prefix

### Permission Denied

- App needs "Repository metadata: Read-only" permission
- Ensure app is installed on the repositories you want to sync

## Multiple Organizations

To sync multiple organizations, run the script multiple times or modify it to loop:

```bash
for org in org1 org2 org3; do
  GITHUB_ORG=$org node scripts/sync-github-data.js
done
```

## Manual Updates

After sync, you still need to manually update:
- `pod` assignments
- `vertical` assignments  
- `engineeringManager` assignments

The sync only updates metadata (description, language, status, lastActivity).

## Monitoring

Check the Actions tab to see:
- Sync status and logs
- Number of repos updated/skipped
- Rate limit remaining
- Any errors

