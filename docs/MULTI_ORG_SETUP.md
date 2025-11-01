# Multi-Organization Setup Guide

This guide explains how to configure the sync script to handle multiple GitHub organizations, each with its own GitHub App.

## Why Multiple Organizations?

If you manage repositories across multiple GitHub organizations, you can:
- Use different GitHub Apps for each org (better security isolation)
- Sync all orgs in a single workflow run
- Maintain separate rate limit pools (15,000 requests/hour per app)

## Configuration Options

There are **three ways** to configure multiple organizations:

### Option 1: Per-Org Secrets (Recommended for GitHub Actions)

Use environment variables with organization names in the variable names.

**Setup in GitHub Secrets:**

1. Create a secret `ORGS_LIST` with a comma-separated list:
   ```
   my-org-1,my-org-2,my-org-3
   ```

2. For each organization, create secrets:
   - `APP_ID_MY_ORG_1` → GitHub App ID for my-org-1
   - `APP_PRIVATE_KEY_MY_ORG_1` → Private key for my-org-1
   - `APP_ID_MY_ORG_2` → GitHub App ID for my-org-2
   - `APP_PRIVATE_KEY_MY_ORG_2` → Private key for my-org-2
   - etc.

**How it works:**
- The script converts org names to uppercase and replaces special chars with `_`
- `my-org-1` becomes `MY_ORG_1`
- Looks for `APP_ID_MY_ORG_1` and `APP_PRIVATE_KEY_MY_ORG_1`

**Example workflow:**

```yaml
env:
  ORGS_LIST: ${{ secrets.ORGS_LIST }}  # "org1,org2"
  APP_ID_ORG1: ${{ secrets.APP_ID_ORG1 }}
  APP_PRIVATE_KEY_ORG1: ${{ secrets.APP_PRIVATE_KEY_ORG1 }}
  APP_ID_ORG2: ${{ secrets.APP_ID_ORG2 }}
  APP_PRIVATE_KEY_ORG2: ${{ secrets.APP_PRIVATE_KEY_ORG2 }}
```

### Option 2: JSON Configuration (Most Flexible)

Store all org configurations in a single JSON secret.

**Create `ORGS_CONFIG` secret with JSON:**

```json
[
  {
    "name": "my-org-1",
    "appId": "123456",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n..."
  },
  {
    "name": "my-org-2",
    "appId": "789012",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n..."
  },
  {
    "name": "my-org-3",
    "appId": "345678",
    "privateKeyBase64": "base64-encoded-key-here"
  }
]
```

**Note:** For GitHub Actions secrets, you may need to escape the JSON (especially newlines in private keys). Consider base64 encoding the entire config:

```bash
# Encode
echo -n '[{"name":"org1",...}]' | base64

# In workflow, decode
ORGS_CONFIG: ${{ secrets.ORGS_CONFIG_BASE64 }}
```

### Option 3: Single Organization (Backward Compatible)

Works as before for a single org:

```yaml
env:
  APP_ID: ${{ secrets.APP_ID }}
  APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
  ORG_NAME: ${{ secrets.ORG_NAME }}
```

Or use the `--org` flag:

```bash
APP_ID=123 APP_PRIVATE_KEY=key node scripts/sync-github-data.js --org=my-org
```

## Complete Example Setup

### Step 1: Create GitHub Apps

For each organization:
1. Create a GitHub App in each org
2. Install the app in that organization
3. Note the App ID and download the private key

### Step 2: Configure Secrets

**Using Option 1 (Per-Org Secrets):**

1. `ORGS_LIST`: `engineering,product,platform`
2. `APP_ID_ENGINEERING`: `123456`
3. `APP_PRIVATE_KEY_ENGINEERING`: `-----BEGIN RSA PRIVATE KEY-----...`
4. `APP_ID_PRODUCT`: `789012`
5. `APP_PRIVATE_KEY_PRODUCT`: `-----BEGIN RSA PRIVATE KEY-----...`
6. `APP_ID_PLATFORM`: `345678`
7. `APP_PRIVATE_KEY_PLATFORM`: `-----BEGIN RSA PRIVATE KEY-----...`

**Using Option 2 (JSON Config):**

Create `ORGS_CONFIG` secret:

```json
[
  {
    "name": "engineering",
    "appId": "123456",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
  },
  {
    "name": "product",
    "appId": "789012",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
  },
  {
    "name": "platform",
    "appId": "345678",
    "privateKeyBase64": "LS0tLS1CRUdJTi..."
  }
]
```

### Step 3: Update Workflow

For Option 1 (Per-Org Secrets):

```yaml
- name: Sync GitHub Repository Data
  env:
    ORGS_LIST: ${{ secrets.ORGS_LIST }}
    APP_ID_ENGINEERING: ${{ secrets.APP_ID_ENGINEERING }}
    APP_PRIVATE_KEY_ENGINEERING: ${{ secrets.APP_PRIVATE_KEY_ENGINEERING }}
    APP_ID_PRODUCT: ${{ secrets.APP_ID_PRODUCT }}
    APP_PRIVATE_KEY_PRODUCT: ${{ secrets.APP_PRIVATE_KEY_PRODUCT }}
    APP_ID_PLATFORM: ${{ secrets.APP_ID_PLATFORM }}
    APP_PRIVATE_KEY_PLATFORM: ${{ secrets.APP_PRIVATE_KEY_PLATFORM }}
  run: |
    node scripts/sync-github-data.js
```

For Option 2 (JSON Config):

```yaml
- name: Sync GitHub Repository Data
  env:
    ORGS_CONFIG: ${{ secrets.ORGS_CONFIG }}
  run: |
    node scripts/sync-github-data.js
```

### Step 4: Test Locally

**Option 1 (Per-Org):**

```bash
export ORGS_LIST="engineering,product"
export APP_ID_ENGINEERING="123456"
export APP_PRIVATE_KEY_ENGINEERING="-----BEGIN RSA PRIVATE KEY-----..."
export APP_ID_PRODUCT="789012"
export APP_PRIVATE_KEY_PRODUCT="-----BEGIN RSA PRIVATE KEY-----..."

node scripts/sync-github-data.js
```

**Option 2 (JSON):**

```bash
export ORGS_CONFIG='[{"name":"engineering","appId":"123456","privateKey":"-----BEGIN..."},{"name":"product","appId":"789012","privateKey":"-----BEGIN..."}]'

node scripts/sync-github-data.js
```

## How It Works

### Sync Process

1. **Parse Configuration**: Reads org configs from environment
2. **Sequential Sync**: Syncs each organization one at a time
3. **Rate Limiting**: Each org has its own rate limit pool
4. **Data Merging**: Combines all repos into single file
5. **Duplicate Handling**: Removes duplicate repos (if same repo in multiple orgs)

### Output Structure

The synced data includes metadata about all organizations:

```json
{
  "metadata": {
    "organizations": ["engineering", "product", "platform"],
    "totalRepos": 1250,
    "updated": 25,
    "skipped": 1225,
    "orgStats": [
      {"updated": 10, "skipped": 400, "errors": 0},
      {"updated": 8, "skipped": 450, "errors": 0},
      {"updated": 7, "skipped": 375, "errors": 0}
    ]
  },
  "repositories": [...]
}
```

## Rate Limits

Each GitHub App installation has its own rate limit pool:
- **15,000 requests/hour per organization**
- If you have 3 orgs with 3 apps: 45,000 total requests/hour capacity
- Syncs run sequentially to avoid conflicts

## Troubleshooting

### "Missing APP_ID_ORG or APP_PRIVATE_KEY_ORG"

- Check that org name in `ORGS_LIST` matches secret names
- Org names are converted: `my-org` → `MY_ORG`
- Special chars become underscores: `org-name` → `ORG_NAME`

### "GitHub App not installed for organization"

- Verify the app is installed in that specific organization
- Check that the App ID matches the installation

### "Invalid ORGS_CONFIG JSON format"

- Validate JSON syntax
- Ensure private keys are properly escaped (use base64 for complex cases)
- Check for trailing commas or missing quotes

## Best Practices

1. **Use Different Apps per Org**: Better security isolation
2. **Start with One Org**: Test single org first, then add more
3. **Use Descriptive Names**: Clear org names make secrets easier to manage
4. **Monitor Rate Limits**: Check logs to ensure you're not hitting limits
5. **Backup Before Sync**: Script automatically backs up, but manual backup recommended

## Migration from Single Org

If you're currently using single org setup:

1. Keep existing secrets (`APP_ID`, `APP_PRIVATE_KEY`, `ORG_NAME`)
2. The script still works in single org mode
3. To add more orgs, choose Option 1 or 2 above
4. Update workflow to include new secrets/config

The script automatically detects which mode to use based on available environment variables.

